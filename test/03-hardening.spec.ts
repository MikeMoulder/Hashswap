import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { setupNox, boolProof, uint256Proof } from "./helpers/nox.js";

/// Regression tests for the security audit findings.
///
/// Each test here corresponds to a way the contract could previously be drained,
/// stalled, or de-anonymised. They are written as attacks rather than as feature
/// checks, so that a regression reads as "the attack worked again" rather than
/// as an unexplained assertion failure.

const ONE = 10n ** 18n;
const WAD = 10n ** 18n;
const TEE_BOOL = 0;
const TEE_UINT256 = 35;
const REF_PRICE = 2000n * WAD;
const POOL_FEE = 3000;

describe("Hardening — audit regressions", () => {
  let viem: any, nox: any, provider: any;
  let hashswap: any, base: any, quote: any, router: any, pool: any;
  let wallets: any[];
  let users: `0x${string}`[];

  beforeEach(async () => {
    ({ viem, nox, provider } = await setupNox());
    wallets = await viem.getWalletClients();
    users = wallets.slice(1, 9).map((w: any) => w.account.address);

    base = await viem.deployContract("MockERC20", ["Base", "BASE", 18]);
    quote = await viem.deployContract("MockERC20", ["Quote", "QUOTE", 18]);
    router = await viem.deployContract("MockSwapRouter");

    await base.write.mint([wallets[0].account.address, 100_000n * ONE]);
    await quote.write.mint([wallets[0].account.address, 200_000_000n * ONE]);
    await base.write.approve([router.address, 100_000n * ONE]);
    await quote.write.approve([router.address, 200_000_000n * ONE]);
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

    for (let i = 1; i <= 8; i++) {
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

  async function vault(token: any, user: `0x${string}`): Promise<bigint> {
    return await nox.read.peek([await hashswap.read.balanceHandleOf([token.address, user])]);
  }

  /// Every participant's credited balance against what the contract really holds.
  /// The vault is solvent when it holds at least what it has promised.
  async function assertSolvent(token: any, label: string) {
    let credited = 0n;
    for (const u of users) credited += await vault(token, u);
    const held: bigint = await token.read.balanceOf([hashswap.address]);
    assert.ok(
      held >= credited,
      `${label}: vault credits ${credited} but holds only ${held} (short ${credited - held})`,
    );
  }

  /// Push the pool price up by buying base, the way a sandwicher would.
  async function pumpPool(quoteIn: bigint) {
    await router.write.exactInputSingle([
      {
        tokenIn: quote.address,
        tokenOut: base.address,
        fee: POOL_FEE,
        recipient: wallets[0].account.address,
        amountIn: quoteIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ]);
  }

  async function closedResidual(batchId: bigint) {
    const b = await hashswap.read.getBatch([batchId]);
    return {
      residual: await nox.read.peek([b.residualHandle]),
      isSell: (await nox.read.peek([b.sellSideHandle])) === 1n,
    };
  }

  // --------------------------------------------------------------- price band

  it("a manipulated pool cannot settle a batch at an unfunded price", async () => {
    await submit(1, 2n * ONE, false);
    await submit(2, 60n * ONE, true);
    await submit(3, 40n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const { residual, isSell } = await closedResidual(1n);

    // Sandwich the settlement: drive the pool far above the reference.
    await pumpPool(15_000_000n * ONE);

    await assert.rejects(
      hashswap.write.settle([
        1n,
        residual,
        uint256Proof(residual),
        isSell,
        boolProof(isSell),
      ]),
      "settling into a manipulated pool must revert, not credit sellers at a price no buyer funded",
    );

    await assertSolvent(quote, "after a refused settlement");
    assert.equal((await hashswap.read.getBatch([1n])).status, 1, "batch stays Closed, refundable");
  });

  it("the refused batch can still be cancelled, so nobody is stranded", async () => {
    await submit(1, 2n * ONE, false);
    await submit(2, 60n * ONE, true);
    await submit(3, 40n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();
    await pumpPool(15_000_000n * ONE);

    const before = await vault(quote, users[1]);

    await provider.request({ method: "evm_increaseTime", params: [3601] });
    await provider.request({ method: "evm_mine", params: [] });
    await hashswap.write.cancelBatch([1n]);

    assert.equal((await hashswap.read.getBatch([1n])).status, 3, "Cancelled");
    assert.ok(
      (await vault(quote, users[1])) > before,
      "the buyer's locked quote comes back",
    );
    await assertSolvent(quote, "after cancellation");
  });

  it("a normal batch still settles inside the band", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const { residual, isSell } = await closedResidual(1n);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), isSell, boolProof(isSell)]);

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(b.status, 2, "Settled");

    const dev = await hashswap.read.MAX_PRICE_DEVIATION_BPS();
    assert.ok(b.clearingPrice >= (REF_PRICE * (10_000n - BigInt(dev))) / 10_000n);
    assert.ok(b.clearingPrice <= (REF_PRICE * (10_000n + BigInt(dev))) / 10_000n);
    await assertSolvent(quote, "after a normal settlement");
  });

  it("the band is tight enough that the buyer's buffer always covers the fill", async () => {
    // The solvency relation the band exists to preserve:
    //   (10_000 + dev) * (10_000 + maxFee) <= BUFFER_BPS * 10_000
    const dev = BigInt(await hashswap.read.MAX_PRICE_DEVIATION_BPS());
    const maxFee = BigInt(await hashswap.read.MAX_MAKER_FEE_BPS());
    const buffer = await hashswap.read.BUFFER_BPS();
    assert.ok(
      (10_000n + dev) * (10_000n + maxFee) <= buffer * 10_000n,
      `band ${dev}bps with fee ${maxFee}bps exceeds what a ${buffer}bps buffer funds`,
    );
  });

  // --------------------------------------------------------- zero clearing price

  it("a dust residual never drives the clearing price to zero", async () => {
    // One wei of net sell. Previously this quoted to zero output, set the
    // clearing price to zero, and poisoned the next batch's reference — after
    // which buys needed no collateral at all.
    await submit(1, 5n * ONE + 1n, false);
    await submit(2, 5n * ONE, true);
    await submit(3, 1n * ONE, false);
    await submit(4, 1n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const { residual, isSell } = await closedResidual(1n);
    assert.equal(residual, 1n, "precondition: a one-wei residual");

    // Either it settles at the reference (absorbed as dust) or it refuses. What
    // it must never do is settle at zero.
    try {
      await hashswap.write.settle([
        1n,
        residual,
        uint256Proof(residual),
        isSell,
        boolProof(isSell),
      ]);
      const b = await hashswap.read.getBatch([1n]);
      assert.ok(b.clearingPrice > 0n, "clearing price must never be zero");
    } catch {
      assert.equal((await hashswap.read.getBatch([1n])).status, 1, "left refundable");
    }

    const next = await hashswap.read.currentBatchId();
    const refPrice = (await hashswap.read.getBatch([next])).refPrice;
    assert.ok(refPrice > 0n, "a zero reference price would make every buy free");
  });

  it("a zero reference price cannot be deployed", async () => {
    await assert.rejects(
      viem.deployContract("HashSwap", [base.address, quote.address, POOL_FEE, router.address, pool.address, 0n]),
      "refPrice = 0 makes quoteNeeded zero for every buyer",
    );
  });

  // ------------------------------------------------------------ batch stuffing

  it("one address cannot occupy more than one slot in a batch", async () => {
    await submit(1, 1n * ONE, false);
    await assert.rejects(
      submit(1, 1n * ONE, false),
      "a single address filling the batch destroys the anonymity set",
    );
    assert.equal((await hashswap.read.getBatch([1n])).count, 1);
  });

  it("an address may resubmit after withdrawing", async () => {
    await submit(1, 1n * ONE, false);
    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });
    await submit(1, 2n * ONE, false);
    assert.equal((await hashswap.read.getBatch([1n])).count, 1);
  });

  it("submit/withdraw churn cannot grow the intent array", async () => {
    // Previously each withdrawal left a tombstone, so this loop grew the array
    // that `_distribute` and `cancelBatch` both walk — eventually past the block
    // gas limit, stranding the collateral the timeout is supposed to rescue.
    for (let i = 0; i < 10; i++) {
      await submit(1, 1n * ONE, false);
      await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });
    }
    const stored = await hashswap.read.intentCount([1n]);
    const max = await hashswap.read.MAX_BATCH_SIZE();
    assert.ok(stored <= BigInt(max), `array holds ${stored}, above MAX_BATCH_SIZE ${max}`);
    assert.equal(stored, 0n, "all withdrawn, so nothing should remain");
  });

  it("intentCount tracks batch.count exactly", async () => {
    await submit(1, 1n * ONE, false);
    await submit(2, 2n * ONE, true);
    await submit(3, 3n * ONE, false);
    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });

    const b = await hashswap.read.getBatch([1n]);
    assert.equal(await hashswap.read.intentCount([1n]), BigInt(b.count));
    assert.equal(b.count, 2);
  });

  it("a swapped-in intent still belongs to its owner", async () => {
    await submit(1, 1n * ONE, false);
    await submit(2, 2n * ONE, true);
    await submit(3, 3n * ONE, false);

    // Removing index 0 moves the last intent into that slot.
    await hashswap.write.withdrawIntent([1n, 0n], { account: wallets[1].account });

    const moved = await hashswap.read.getIntent([1n, 0n]);
    assert.equal(moved.user.toLowerCase(), users[2].toLowerCase(), "wallet 3's intent moved down");

    await assert.rejects(
      hashswap.write.withdrawIntent([1n, 0n], { account: wallets[2].account }),
      "a stale index must not let someone withdraw another user's intent",
    );
  });

  // ------------------------------------------------------------- maker terms

  it("maker terms are frozen once a batch has a participant", async () => {
    await submit(1, 6n * ONE, false);

    // The owner installs a maker after collateral is already committed.
    await hashswap.write.setMaker([users[7], 50]);

    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const sellerBefore = await vault(quote, users[0]);
    const makerBefore = await vault(quote, users[7]);
    const { residual, isSell } = await closedResidual(1n);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), isSell, boolProof(isSell)]);

    const price = (await hashswap.read.getBatch([1n])).clearingPrice;
    assert.equal(
      await vault(quote, users[0]),
      sellerBefore + (6n * ONE * price) / WAD,
      "the retro-installed maker must not take a spread from this batch",
    );
    assert.equal(
      await vault(quote, users[7]),
      makerBefore,
      "maker earned nothing on a batch whose terms were already frozen",
    );
  });

  it("maker terms set before anyone commits do apply", async () => {
    await hashswap.write.setMaker([users[7], 50]);
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const { residual, isSell } = await closedResidual(1n);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), isSell, boolProof(isSell)]);

    assert.ok((await vault(quote, users[7])) > 0n, "maker collects the spread it advertised");
  });

  // ------------------------------------------------------------- state machine

  it("settle only accepts the current batch", async () => {
    await submit(1, 6n * ONE, false);
    await submit(2, 4n * ONE, false);
    await submit(3, 8n * ONE, true);
    await advancePastWindow();
    await hashswap.write.closeBatch();

    const { residual, isSell } = await closedResidual(1n);
    await hashswap.write.settle([1n, residual, uint256Proof(residual), isSell, boolProof(isSell)]);

    // Batch 1 is settled and batch 2 is open; replaying must not open a third.
    await assert.rejects(
      hashswap.write.settle([1n, residual, uint256Proof(residual), isSell, boolProof(isSell)]),
    );
    assert.equal(await hashswap.read.currentBatchId(), 2n);
  });

  // ------------------------------------------------------- fee-on-transfer

  it("deposit credits what arrived, not what was asked for", async () => {
    const fee = await viem.deployContract("MockFeeToken", [500n]); // 5% burn
    const account = wallets[1].account;
    await fee.write.mint([account.address, 1_000n * ONE]);
    await fee.write.approve([hashswap.address, 1_000n * ONE], { account });

    await hashswap.write.deposit([fee.address, 100n * ONE], { account });

    const credited = await nox.read.peek([
      await hashswap.read.balanceHandleOf([fee.address, users[0]]),
    ]);
    const held = await fee.read.balanceOf([hashswap.address]);

    assert.equal(held, 95n * ONE, "5% was burned in transit");
    assert.equal(credited, held, "the vault must credit the delta it actually received");
  });
});
