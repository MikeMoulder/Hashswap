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

describe("Stages 2-3 — batching, netting, settlement", () => {
  let viem: any, nox: any, provider: any;
  let hashswap: any, base: any, quote: any, router: any;
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

    hashswap = await viem.deployContract("HashSwap", [
      base.address,
      quote.address,
      POOL_FEE,
      router.address,
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
      boolProof(true),
      0n,
    ]);

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
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true), 0n]);

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
    await hashswap.write.settle([1n, 0n, uint256Proof(0n), false, boolProof(false), 0n]);

    assert.equal(
      await router.read.reserves([base.address]),
      poolBefore,
      "a fully internalised batch leaves zero on-chain trace in the pool",
    );
    assert.equal((await hashswap.read.getBatch([1n])).clearingPrice, REF_PRICE);
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
      boolProof(false),
      1_000_000n * ONE,
    ]);
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
        boolProof(true),
        0n,
      ]),
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
    await hashswap.write.settle([1n, residual, uint256Proof(residual), false, boolProof(false), 1_000_000n * ONE]);

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
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true), 0n]);

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
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true), 0n]);

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
    await hashswap.write.settle([1n, residual, uint256Proof(residual), true, boolProof(true), 0n]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;
    const ownFill = (6n * ONE * price) / WAD;

    // Its own fill is untaxed, and it also collects the spread from the others.
    assert.ok(
      (await balance(quote, MAKER)) > before + ownFill,
      "maker should keep its full fill and collect the others' spread",
    );
  });
});
