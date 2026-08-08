import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { setupNox, boolProof, uint256Proof } from "./helpers/nox.js";

/// Stages 2 and 3 — batching, netting, and two-phase settlement.
///
/// Logic only (MockNoxCompute). Confidentiality (I5), keeper-cannot-lie (I7),
/// gas, and async handle resolution are Sepolia-only.

const ONE = 10n ** 18n;
const WAD = 10n ** 18n;

/// TEEType enum indices: Bool = 0; unsigned ints start at 4 for Uint8 and step
/// one per byte of width, so Uint256 = 4 + 31 = 35.
const TEE_BOOL = 0;
const TEE_UINT256 = 35;

const REF_PRICE = 2000n * WAD; // 2000 quote per base
const POOL_FEE = 3000;

/// Reference prices now come from the pool rather than from the contract's own
/// last trade, which means they arrive via a real Q64.96 `sqrtPriceX96` and an
/// integer square root. A WAD price round-trips through that a few parts in
/// 1e12 off its nominal value.
///
/// Compare with a tolerance rather than exactly. Making these assertions exact
/// again would mean a mock that hands back the number it was given, which would
/// pass whether or not the conversion under test worked at all.
function assertNear(actual: bigint, expected: bigint, what: string, toleranceBps = 1n) {
  const diff = actual > expected ? actual - expected : expected - actual;
  assert.ok(
    diff * 10_000n <= expected * toleranceBps,
    `${what} — got ${actual}, expected ~${expected}`,
  );
}

describe("Stages 2-3 — batching, netting, settlement", () => {
  let viem: any, nox: any, provider: any;
  let hashswap: any, base: any, quote: any, router: any, pool: any;
  let wallets: any[];
  let users: `0x${string}`[];

  beforeEach(async () => {
    ({ viem, nox, provider } = await setupNox());
    wallets = await viem.getWalletClients();
    users = wallets.slice(1, 6).map((w: any) => w.account.address);

    base = await viem.deployContract("MockERC20", ["Base", "BASE", 18]);
    quote = await viem.deployContract("MockERC20", ["Quote", "QUOTE", 18]);
    router = await viem.deployContract("MockSwapRouter");

    // Deep reserves at 2000 quote per base, so residual slippage stays small.
    await base.write.mint([wallets[0].account.address, 10_000n * ONE]);
    await quote.write.mint([wallets[0].account.address, 20_000_000n * ONE]);
    await base.write.approve([router.address, 10_000n * ONE]);
    await quote.write.approve([router.address, 20_000_000n * ONE]);
    await router.write.seed([base.address, 10_000n * ONE]);
    await router.write.seed([quote.address, 20_000_000n * ONE]);

    pool = await viem.deployContract("MockUniswapV3Pool", [
      base.address,
      quote.address,
      POOL_FEE,
      REF_PRICE,
      base.address,
    ]);

    hashswap = await viem.deployContract("HashSwap", [
      base.address,
      quote.address,
      POOL_FEE,
      router.address,
      pool.address,
      REF_PRICE,
    ]);

    // Fund every participant's confidential balance on both sides.
    for (let i = 1; i <= 5; i++) {
      const account = wallets[i].account;
      await base.write.mint([account.address, 1_000n * ONE]);
      await quote.write.mint([account.address, 2_000_000n * ONE]);
      await base.write.approve([hashswap.address, 1_000n * ONE], { account });
      await quote.write.approve([hashswap.address, 2_000_000n * ONE], { account });
      await hashswap.write.deposit([base.address, 1_000n * ONE], { account });
      await hashswap.write.deposit([quote.address, 2_000_000n * ONE], { account });
    }
  });

  async function mint(value: bigint, teeType: number): Promise<`0x${string}`> {
    await nox.write.mintExternal([value, teeType]);
    return await nox.read.lastMinted();
  }

  /// Submit an encrypted intent. `isBuy` false means selling base.
  async function submit(walletIndex: number, amount: bigint, isBuy: boolean) {
    const account = wallets[walletIndex].account;
    const amountHandle = await mint(amount, TEE_UINT256);
    const sideHandle = await mint(isBuy ? 1n : 0n, TEE_BOOL);
    await hashswap.write.submitIntent([amountHandle, "0x00", sideHandle, "0x00"], { account });
  }

  async function advancePastWindow() {
    await provider.request({ method: "evm_increaseTime", params: [120] });
    await provider.request({ method: "evm_mine", params: [] });
  }

  async function balance(token: any, user: `0x${string}`): Promise<bigint> {
    return await nox.read.peek([await hashswap.read.balanceHandleOf([token.address, user])]);
  }

  // ------------------------------------------------------------------ batching

  it("intents move no tokens — the vault balance changes, the wallet does not", async () => {
    const walletBefore = await base.read.balanceOf([users[0]]);
    const vaultBefore = await balance(base, users[0]);

    await submit(1, 10n * ONE, false);

    assert.equal(
      await base.read.balanceOf([users[0]]),
      walletBefore,
      "submitIntent must not touch ERC-20 balances — that would leak the amount (F1)",
    );
    assert.equal(await balance(base, users[0]), vaultBefore - 10n * ONE);
  });

  it("a batch below MIN_BATCH_SIZE rolls over instead of settling", async () => {
    await submit(1, 5n * ONE, false);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(b.status, 0, "status must still be Open — a 1-intent batch reveals its member");
    assert.equal(await hashswap.read.currentBatchId(), 1n);
  });

  it("closing before the window elapses reverts", async () => {
    await submit(1, 1n * ONE, false);
    await submit(2, 1n * ONE, true);
    await submit(3, 1n * ONE, false);
    await assert.rejects(hashswap.write.closeBatch());
  });

  // ------------------------------------------------------------------- netting

  // The pitch's own worked example, as a test.
  it("Alice sells 6, Dave sells 4, Bob buys 8 -> only 2 base reaches the pool", async () => {
    await submit(1, 6n * ONE, false); // Alice sells 6
    await submit(2, 4n * ONE, false); // Dave sells 4
    await submit(3, 8n * ONE, true); // Bob buys 8

    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(b.status, 1, "Closed");

    const residual = await nox.read.peek([b.residualHandle]);
    const isSell = (await nox.read.peek([b.sellSideHandle])) === 1n;

    assert.equal(residual, 2n * ONE, "8 of the 10 base crossed internally");
    assert.equal(isSell, true, "net sell pressure");
  });

  it("settlement swaps only the residual and clears everyone at one price", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);

    const poolBaseBefore = await router.read.reserves([base.address]);

    await hashswap.write.settle([
      1n,
      residual,
      uint256Proof(residual),
      true,
      boolProof(true)]);

    const after = await hashswap.read.getBatch([1n]);
    assert.equal(after.status, 2, "Settled");

    assert.equal(
      (await router.read.reserves([base.address])) - poolBaseBefore,
      2n * ONE,
      "exactly the residual touched Uniswap, not the 18 base of gross volume",
    );

    // Clearing price should land near the reference; the residual is small.
    const drift =
      after.clearingPrice > REF_PRICE
        ? after.clearingPrice - REF_PRICE
        : REF_PRICE - after.clearingPrice;
    assert.ok(
      drift * 100n < REF_PRICE,
      `clearing price ${after.clearingPrice} drifted too far from ${REF_PRICE}`,
    );
  });

  it("sellers are paid quote and buyers receive base, all at the clearing price", async () => {
    const bobBaseBefore = await balance(base, users[2]);

    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true)]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;

    assert.equal(
      await balance(base, users[2]),
      bobBaseBefore + 8n * ONE,
      "buyer receives the base they asked for",
    );

    // Alice sold 6 base and should hold her original quote plus 6 * price,
    // having started at 2,000,000 and spent nothing.
    const aliceQuote = await balance(quote, users[0]);
    assert.equal(aliceQuote, 2_000_000n * ONE + (6n * ONE * price) / WAD);
  });

  it("a zero residual settles with no Uniswap interaction at all", async () => {
    await submit(1, 5n * ONE, false);
    await submit(2, 5n * ONE, true);
    await submit(3, 3n * ONE, false);
    await submit(4, 3n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(await nox.read.peek([b.residualHandle]), 0n, "perfectly balanced");

    const poolBefore = await router.read.reserves([base.address]);
    await hashswap.write.settle([1n, 0n, uint256Proof(0n), false, boolProof(false)]);

    assert.equal(
      await router.read.reserves([base.address]),
      poolBefore,
      "a fully internalised batch leaves zero on-chain trace in the pool",
    );
    // Nothing traded, so the batch clears at its own reference — which is now
    // the pool's price at open rather than a number handed to the constructor.
    assertNear(
      (await hashswap.read.getBatch([1n])).clearingPrice,
      REF_PRICE,
      "a fully internalised batch clears at its reference price",
    );
  });

  it("net-buy residual settles through an exact-output swap", async () => {
    await submit(1, 2n * ONE, false);
    await submit(2, 5n * ONE, true);
    await submit(3, 4n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    assert.equal(residual, 7n * ONE, "9 bought - 2 sold");
    assert.equal(await nox.read.peek([b.sellSideHandle]), 0n, "net buy");

    await hashswap.write.settle([
      1n,
      residual,
      uint256Proof(residual),
      false,
      boolProof(false)]);
    assert.equal((await hashswap.read.getBatch([1n])).status, 2);
  });

  // ---------------------------------------------------------------- keeper lie

  it("a keeper reporting the wrong residual is rejected", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    // The proof and the claimed value disagree, so the on-chain check fails.
    // NOTE: locally this only proves the *comparison* works. The mock does not
    // verify gateway signatures, so a keeper who forges a matching proof would
    // pass here. Invariant I7 is only truly established on Sepolia.
    await assert.rejects(
      hashswap.write.settle([
        1n,
        99n * ONE,
        uint256Proof(2n * ONE),
        true,
        boolProof(true)]),
    );
  });

  // -------------------------------------------------------------- fund safety

  it("an unsettled batch can be cancelled and everyone is refunded", async () => {
    const aliceBaseBefore = await balance(base, users[0]);
    const bobQuoteBefore = await balance(quote, users[2]);

    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    // Keeper never shows up.
    await provider.request({ method: "evm_increaseTime", params: [3700] });
    await provider.request({ method: "evm_mine", params: [] });

    await hashswap.write.cancelBatch([1n]);

    assert.equal((await hashswap.read.getBatch([1n])).status, 3, "Cancelled");
    assert.equal(await balance(base, users[0]), aliceBaseBefore, "seller's base returned");
    assert.equal(await balance(quote, users[2]), bobQuoteBefore, "buyer's locked quote returned");
  });

  it("cancelling before the timeout reverts", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    await assert.rejects(hashswap.write.cancelBatch([1n]));
  });

  // ------------------------------------------------------------------ liveness
  //
  // A closed batch used to be the market's single point of failure: the
  // successor was opened at the end of `settle`, so between close and settlement
  // `currentBatchId` pointed at a Closed batch and nobody could trade. A batch
  // that could not settle — a reference price left behind by a drifting pool is
  // enough — froze the market for the full SETTLE_TIMEOUT, and the only thing
  // that could reopen it was the transaction that could not be sent. Observed on
  // Sepolia: WETH-LINK batch 18, closed against a 2-day-old reference.

  it("closing opens the successor at once, so orders never stop", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    assert.equal(await hashswap.read.currentBatchId(), 2n, "successor opened by closeBatch");
    assert.equal((await hashswap.read.getBatch([2n])).status, 0, "and it is Open");
    assert.equal(await hashswap.read.pendingSettlement(), 1n, "batch 1 still owes a settlement");
  });

  it("a batch awaiting settlement does not block new orders", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    // Batch 1 is closed and unsettled. This is the transaction that used to
    // revert with BatchNotOpen for a whole hour.
    await submit(4, 2n * ONE, false);

    assert.equal((await hashswap.read.getBatch([2n])).count, 1, "order landed in the successor");
  });

  it("a batch that can never settle still does not halt the market", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    // The keeper never comes. Trading continues throughout, and the stranded
    // batch is refunded on the timeout without the successor being disturbed.
    await submit(4, 3n * ONE, true);
    await provider.request({ method: "evm_increaseTime", params: [3700] });
    await provider.request({ method: "evm_mine", params: [] });

    await hashswap.write.cancelBatch([1n]);

    assert.equal(await hashswap.read.currentBatchId(), 2n, "cancel must not open a third batch");
    assert.equal((await hashswap.read.getBatch([2n])).status, 0, "successor untouched and Open");
    assert.equal((await hashswap.read.getBatch([2n])).count, 1, "and it kept its order");
    assert.equal(await hashswap.read.pendingSettlement(), 0n, "queue cleared");
  });

  it("only one batch may await settlement at a time", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    await submit(1, 1n * ONE, false);
    await submit(2, 1n * ONE, true);
    await submit(3, 1n * ONE, false);
    await advancePastWindow();

    // Without this bound, a batch stuck on a stale reference is followed by more
    // batches inheriting the same reference, each closing into the same
    // unsettleable state — a cascade of locked collateral rather than one hour.
    await assert.rejects(hashswap.write.closeBatch(), /SettlementPending|reverted/);
  });

  // ------------------------------------------------------------- reference price

  it("settling re-anchors the open batch to the price just discovered", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    assertNear(
      (await hashswap.read.getBatch([2n])).refPrice,
      REF_PRICE,
      "successor opens on the pool's price, which has not moved yet",
    );

    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    const isSell = (await nox.read.peek([b.sellSideHandle])) === 1n;
    await hashswap.write.settle([
      1n,
      residual,
      uint256Proof(residual),
      isSell,
      boolProof(isSell),
    ]);

    const cleared = (await hashswap.read.getBatch([1n])).clearingPrice;
    assert.equal(
      (await hashswap.read.getBatch([2n])).refPrice,
      cleared,
      "the open batch must track the last traded price, or it goes stale and stops settling",
    );
  });

  it("re-anchoring stops once someone has committed to the open batch", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    // A buyer commits to batch 2 before batch 1 settles. Their collateral was
    // sized off REF_PRICE, and `settle` draws its band around the same number —
    // moving it now would break that pairing.
    await submit(4, 2n * ONE, true);
    const quoteAfterLock = await balance(quote, users[3]);

    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    const isSell = (await nox.read.peek([b.sellSideHandle])) === 1n;
    await hashswap.write.settle([
      1n,
      residual,
      uint256Proof(residual),
      isSell,
      boolProof(isSell),
    ]);

    assertNear(
      (await hashswap.read.getBatch([2n])).refPrice,
      REF_PRICE,
      "a batch that has taken an order keeps the reference it advertised",
    );
    assert.equal(
      await balance(quote, users[3]),
      quoteAfterLock,
      "and the committed buyer's lock is untouched",
    );
  });

  // ------------------------------------------------------------- griefing (F7)

  it("an unfunded intent contributes zero without breaking the batch", async () => {
    // Wallet 5 drains its own base balance first, then tries to sell.
    await hashswap.write.requestWithdraw([base.address, 1_000n * ONE], {
      account: wallets[5].account,
    });
    await hashswap.write.finalizeWithdraw([1n, boolProof(true)]);
    assert.equal(await balance(base, users[4]), 0n);

    await submit(5, 500n * ONE, false); // unfunded — must contribute nothing
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);

    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(
      await nox.read.peek([b.residualHandle]),
      2n * ONE,
      "the unfunded 500 must not appear in the netting totals",
    );
  });

  // ------------------------------------------------- buy-side collateral (F7)

  // Buys lock quote at refPrice * BUFFER_BPS, not at refPrice, because the
  // clearing price does not exist yet. That 5% is easy to forget on the client,
  // and forgetting it is expensive precisely because nothing reverts: `_debit`
  // answers a shortfall with zero, the intent still increments `count`, and the
  // user pays gas for an order that silently did not happen.
  //
  // Both sides of the boundary are asserted. A test for the shortfall alone
  // would still pass if buys were broken outright.

  const buyQuote = (baseAmount: bigint, bps: bigint) =>
    (baseAmount * ((REF_PRICE * bps) / 10_000n)) / WAD;

  /// Leave `keep` quote in wallet 5's vault and nothing more.
  async function trimQuoteTo(keep: bigint) {
    const held = await balance(quote, users[4]);
    await hashswap.write.requestWithdraw([quote.address, held - keep], {
      account: wallets[5].account,
    });
    await hashswap.write.finalizeWithdraw([1n, boolProof(true)]);
    assert.equal(await balance(quote, users[4]), keep);
  }

  it("a buy collateralised at only the face amount contributes zero", async () => {
    // 10 base at the reference price is 20,000 quote, but the contract wants
    // 21,000. One wei short is the same as empty.
    await trimQuoteTo(buyQuote(10n * ONE, 10_000n));

    await submit(5, 10n * ONE, true); // must contribute nothing
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);

    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(Number(b.count), 4, "the intent still joins the batch — refusing it would leak solvency");
    assert.equal(
      await nox.read.peek([b.residualHandle]),
      2n * ONE,
      "an under-collateralised buy must not reach the netting totals",
    );
    assert.equal(
      (await nox.read.peek([b.sellSideHandle])) === 1n,
      true,
      "totals must read 10 sell against 8 buy, not 18 buy",
    );
  });

  it("a buy collateralised at BUFFER_BPS is accepted in full", async () => {
    await trimQuoteTo(buyQuote(10n * ONE, 10_500n));

    await submit(5, 10n * ONE, true); // exactly funded — must count
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);

    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(
      await nox.read.peek([b.residualHandle]),
      8n * ONE,
      "18 buy against 10 sell leaves 8",
    );
    assert.equal(
      (await nox.read.peek([b.sellSideHandle])) === 1n,
      false,
      "net buy pressure once the buy is counted",
    );
  });

  it("BUFFER_BPS is readable, so clients need not hardcode it", async () => {
    // The frontend has to know this number to size a deposit. Reading it beats
    // copying it: a client copy that drifts below the contract's produces orders
    // that look placed and do nothing.
    // Derived from the band, the pool's fee, and the maker fee cap rather than
    // written down, so assert the derivation rather than a copied constant —
    // a hardcoded expectation here would have to be edited in lockstep with the
    // contract, which is the coupling the change removed.
    const band = BigInt(await hashswap.read.MAX_PRICE_DEVIATION_BPS());
    const poolBps = BigInt(await hashswap.read.poolFeeBps());
    const makerCap = BigInt(await hashswap.read.MAX_MAKER_FEE_BPS());
    const worst = (10_000n + band) * (10_000n + poolBps) * (10_000n + makerCap);
    const expected = (worst + (10n ** 8n - 1n)) / 10n ** 8n;

    assert.equal(await hashswap.read.BUFFER_BPS(), expected);
    assert.ok(expected >= 10_000n, "a buffer below par would under-collateralise every buy");
  });
  // --------------------------------------------------------- pool-priced batches

  it("prices correctly whichever side of the pool the base token sits on", async () => {
    // token0/token1 is decided by address order and says nothing about which
    // token is the base, so `PoolOracle` has to invert the ratio for half of all
    // pairs. Every market deployed so far happens to land on the same side of
    // that branch, which means the other half is exercised only here.
    const P = 1234n * WAD;
    const [low, high] =
      base.address.toLowerCase() < quote.address.toLowerCase() ? [base, quote] : [quote, base];

    for (const [b, q, label] of [
      [low, high, "base is token0"],
      [high, low, "base is token1"],
    ] as const) {
      const p = await viem.deployContract("MockUniswapV3Pool", [
        b.address,
        q.address,
        POOL_FEE,
        P,
        b.address,
      ]);
      const hs = await viem.deployContract("HashSwap", [
        b.address,
        q.address,
        POOL_FEE,
        router.address,
        p.address,
        P,
      ]);
      assertNear((await hs.read.getBatch([1n])).refPrice, P, label);
    }
  });

  it("a cancelled batch does not hand its stale price to the successor", async () => {
    // The ratchet, as a test. A batch that fails to settle used to reopen its
    // successor on the same reference that just failed, so one unsettleable
    // batch begat the next indefinitely — on Sepolia one market drifted 60% from
    // its pool this way and could no longer clear a buy of any size.
    await submit(1, 1n * ONE, false);
    await submit(2, 1n * ONE, true);
    await submit(3, 1n * ONE, false);
    await advancePastWindow();

    // The market moves before the batch closes. `closeBatch` opens the
    // successor, so that is the moment the new reference is chosen.
    const moved = (REF_PRICE * 130n) / 100n;
    await pool.write.setPrice([moved, base.address]);
    await hashswap.write.closeBatch();

    assertNear(
      (await hashswap.read.getBatch([2n])).refPrice,
      moved,
      "the successor must open on the pool, not on the reference it inherited",
    );
  });

  it("falls back to the inherited price when spot has been pushed off the mean", async () => {
    await submit(1, 1n * ONE, false);
    await submit(2, 1n * ONE, true);
    await submit(3, 1n * ONE, false);
    await advancePastWindow();

    // Spot far from the time-weighted mean is what a manipulation attempt looks
    // like from inside the contract. Pricing off it is exactly what must not
    // happen — and reverting is equally unacceptable, because `_openBatch` sits
    // on the path that lets a stuck batch refund.
    await pool.write.setPrice([(REF_PRICE * 130n) / 100n, base.address]);
    await pool.write.setTicks([5000, 0]);
    await hashswap.write.closeBatch();

    const successor = await hashswap.read.getBatch([2n]);
    assertNear(
      successor.refPrice,
      REF_PRICE,
      "a manipulated pool must not set the reference — the inherited one stands",
    );
    assert.equal(successor.status, 0, "and the batch must still have opened");
  });

  it("a pool with one observation cannot be used as an oracle", async () => {
    // `observe` on a single-observation pool extrapolates from the current tick,
    // so the "mean" it returns is spot wearing a costume and the deviation check
    // would be comparing a value against itself. The WETH-LINK pool on Sepolia
    // was in exactly this state.
    await submit(1, 1n * ONE, false);
    await submit(2, 1n * ONE, true);
    await submit(3, 1n * ONE, false);
    await advancePastWindow();

    await pool.write.setPrice([(REF_PRICE * 130n) / 100n, base.address]);
    await pool.write.setCardinality([1]);
    await hashswap.write.closeBatch();

    assertNear(
      (await hashswap.read.getBatch([2n])).refPrice,
      REF_PRICE,
      "one observation is not an oracle",
    );
  });

  // ------------------------------------------------------- stuck-batch liveness

  // MIN_BATCH_SIZE means a quiet market can roll a batch forever. Without an
  // escape hatch the collateral is debited and unreachable: cancelBatch only
  // applies to Closed batches, so an Open one that never fills has no exit.
  it("an intent can be withdrawn from a batch that never fills", async () => {
    const baseBefore = await balance(base, users[0]);

    await submit(1, 6n * ONE, false);
    assert.equal(await balance(base, users[0]), baseBefore - 6n * ONE);

    // Window rolls; still only one intent, so it never settles.
    await advancePastWindow();
    await hashswap.write.closeBatch();
    assert.equal((await hashswap.read.getBatch([1n])).status, 0, "still Open");

    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });

    assert.equal(await balance(base, users[0]), baseBefore, "collateral returned in full");
    assert.equal((await hashswap.read.getBatch([1n])).count, 0);
  });

  it("a withdrawn buy returns the locked quote", async () => {
    const quoteBefore = await balance(quote, users[2]);
    await submit(3, 8n * ONE, true);
    assert.ok(await balance(quote, users[2]) < quoteBefore, "quote was locked");

    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[3].account });
    assert.equal(await balance(quote, users[2]), quoteBefore, "locked quote returned");
  });

  it("withdrawing removes the volume from the netting totals", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);

    // Dave pulls his 4 out, so sells drop 10 -> 6 and the batch flips to net buy.
    await hashswap.write.withdrawIntent([1n, 1n], { account: wallets[2].account });
    await submit(4, 1n * ONE, false);
    await submit(5, 1n * ONE, false);

    await advancePastWindow();
    await hashswap.write.closeBatch();

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(await nox.read.peek([b.residualHandle]), 0n, "6+1+1 sold vs 8 bought");
  });

  it("only the owner can withdraw an intent, and only once", async () => {
    await submit(1, 6n * ONE, false);
    await assert.rejects(
      hashswap.write.withdrawIntent([1n, 0n], { account: wallets[2].account }),
      "a stranger must not be able to withdraw someone else's intent",
    );
    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });
    await assert.rejects(
      hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account }),
      "double withdrawal must revert",
    );
  });

  it("a withdrawn intent is not filled or double-refunded at settlement", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await submit(4, 2n * ONE, false);

    const daveBase = await balance(base, users[1]);
    await hashswap.write.withdrawIntent([1n, 1n], { account: wallets[2].account });
    const daveAfterWithdraw = await balance(base, users[1]);
    assert.equal(daveAfterWithdraw, daveBase + 4n * ONE);

    await advancePastWindow();
    await hashswap.write.closeBatch();
    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), false, boolProof(false)]);

    assert.equal(
      await balance(base, users[1]),
      daveAfterWithdraw,
      "withdrawn intent must receive nothing at settlement",
    );
  });
  // ------------------------------------------------------- maker of last resort

  // A maker paid to always take the other side is what stops a low-volume batch
  // waiting on strangers who may never arrive. It buys liveness, not privacy:
  // a maker padding a batch with one real user can subtract its own orders and
  // derive that user's position. The contract documents that; these tests only
  // check the economics.

  it("only the owner can configure the maker", async () => {
    await assert.rejects(
      hashswap.write.setMaker([users[4], 10], { account: wallets[2].account }),
      "a stranger must not be able to install a maker",
    );
    await hashswap.write.setMaker([users[4], 10]);
    assert.equal((await hashswap.read.maker()).toLowerCase(), users[4].toLowerCase());
    assert.equal(await hashswap.read.makerFeeBps(), 10);
  });

  it("the maker fee is capped", async () => {
    const cap = await hashswap.read.MAX_MAKER_FEE_BPS();
    await assert.rejects(hashswap.write.setMaker([users[4], cap + 1]));
    await hashswap.write.setMaker([users[4], cap]);
    assert.equal(await hashswap.read.makerFeeBps(), cap);
  });

  it("with no maker set, fills are unchanged", async () => {
    const before = await balance(quote, users[0]);
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();
    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true)]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;
    assert.equal(
      await balance(quote, users[0]),
      before + (6n * ONE * price) / WAD,
      "seller should receive the full clearing value when no maker is configured",
    );
  });

  it("the maker accrues the spread from every other participant", async () => {
    const MAKER = users[4];
    const FEE = 25n; // bps
    await hashswap.write.setMaker([MAKER, Number(FEE)]);
    const makerBefore = await balance(quote, MAKER);
    const sellerBefore = await balance(quote, users[0]);

    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();
    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true)]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;

    // Seller of 6 receives the clearing value less the spread.
    const gross = (6n * ONE * price) / WAD;
    const fee = (gross * FEE) / 10_000n;
    assert.equal(
      await balance(quote, users[0]),
      sellerBefore + gross - fee,
      "seller should be short exactly the spread",
    );

    assert.ok(
      (await balance(quote, MAKER)) > makerBefore,
      "maker should have accrued the spread",
    );
  });

  it("the maker does not pay the spread on its own orders", async () => {
    const MAKER = users[0]; // wallet 1 is both maker and a participant
    await hashswap.write.setMaker([MAKER, 25]);
    const before = await balance(quote, MAKER);

    await submit(1, 6n * ONE, false); // the maker's own sell
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();
    const b = await hashswap.read.getBatch([1n]);
    const residual = await nox.read.peek([b.residualHandle]);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true)]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;
    const ownFill = (6n * ONE * price) / WAD;

    // Its own fill is untaxed, and it also collects the spread from the others.
    assert.ok(
      (await balance(quote, MAKER)) > before + ownFill,
      "maker should keep its full fill and collect the others' spread",
    );
  });
});
