import { network } from "hardhat";

/// The side-by-side demo: the same trade, naked versus through HashSwap.
///
///   npx hardhat run scripts/demo/run-both.ts
///
/// Runs entirely locally and deterministically — no Docker, no testnet, no
/// network flakiness on stage. Lane A touches no Nox code at all, so a problem
/// in the confidential stack cannot take down the half of the demo that carries
/// the argument (build.md F10).
///
/// Lane A: victim broadcasts a swap. An attacker sees the amount sitting in the
/// mempool, front-runs it, lets the victim fill at the worsened price, then
/// unwinds. Standard sandwich.
///
/// Lane B: identical trade, submitted as an encrypted intent. The attacker sees
/// a 32-byte handle and has nothing to act on. The trade is also netted against
/// opposing flow, so most of it never reaches the pool at all.

const ONE = 10n ** 18n;
const REF_PRICE = 2000n * ONE;
const POOL_FEE = 3000;
const NOX_COMPUTE_LOCAL = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";

const BASE_RESERVE = 1_000n * ONE;
const QUOTE_RESERVE = 2_000_000n * ONE;

const VICTIM_SIZE = 10n * ONE;
const ATTACKER_SIZE = 150n * ONE;

const TEE_BOOL = 0;
const TEE_UINT256 = 35;

const fmt = (v: bigint, dp = 2) => {
  // Group the integer part only — applying the separator to the whole string
  // also groups the decimals and renders 1.6498 as "1.6,498".
  const [int, dec] = (Number(v) / 1e18).toFixed(dp).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec ? `.${dec}` : "");
};
const bar = (ch = "─", n = 64) => ch.repeat(n);

async function freshPool(viem: any, deployer: string) {
  const base = await viem.deployContract("MockERC20", ["Base", "BASE", 18]);
  const quote = await viem.deployContract("MockERC20", ["Quote", "QUOTE", 18]);
  const router = await viem.deployContract("MockSwapRouter");

  await base.write.mint([deployer, BASE_RESERVE * 10n]);
  await quote.write.mint([deployer, QUOTE_RESERVE * 10n]);
  await base.write.approve([router.address, BASE_RESERVE * 10n]);
  await quote.write.approve([router.address, QUOTE_RESERVE * 10n]);
  await router.write.seed([base.address, BASE_RESERVE]);
  await router.write.seed([quote.address, QUOTE_RESERVE]);

  return { base, quote, router };
}

/// ---------------------------------------------------------------- LANE A
/// Pure Uniswap mechanics. No Nox, no HashSwap, no confidential anything.
async function laneA(viem: any, wallets: any[]) {
  const deployer = wallets[0].account.address;
  const attacker = wallets[8].account;
  const { base, quote, router } = await freshPool(viem, deployer);

  const victim = wallets[7].account;
  await base.write.mint([victim.address, VICTIM_SIZE]);
  await base.write.approve([router.address, VICTIM_SIZE], { account: victim });

  await base.write.mint([attacker.address, ATTACKER_SIZE]);
  await base.write.approve([router.address, ATTACKER_SIZE], { account: attacker });

  // What the victim would have received in an empty block.
  const fairQuote = await router.read.quote([base.address, quote.address, VICTIM_SIZE]);

  // 1. Front-run — the attacker read the victim's amount from the mempool.
  await router.write.exactInputSingle(
    [{
      tokenIn: base.address, tokenOut: quote.address, fee: POOL_FEE,
      recipient: attacker.address, amountIn: ATTACKER_SIZE,
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
    { account: attacker },
  );

  // 2. The victim executes into the worsened price.
  const victimQuoteBefore = await quote.read.balanceOf([victim.address]);
  await router.write.exactInputSingle(
    [{
      tokenIn: base.address, tokenOut: quote.address, fee: POOL_FEE,
      recipient: victim.address, amountIn: VICTIM_SIZE,
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
    { account: victim },
  );
  const victimReceived = (await quote.read.balanceOf([victim.address])) - victimQuoteBefore;

  // 3. Back-run — unwind into the victim's own price impact.
  const attackerQuote = await quote.read.balanceOf([attacker.address]);
  await quote.write.approve([router.address, attackerQuote], { account: attacker });
  await router.write.exactInputSingle(
    [{
      tokenIn: quote.address, tokenOut: base.address, fee: POOL_FEE,
      recipient: attacker.address, amountIn: attackerQuote,
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }],
    { account: attacker },
  );

  const attackerBaseAfter = await base.read.balanceOf([attacker.address]);
  const attackerProfitBase =
    attackerBaseAfter > ATTACKER_SIZE ? attackerBaseAfter - ATTACKER_SIZE : 0n;

  return {
    fairQuote,
    victimReceived,
    lost: fairQuote > victimReceived ? fairQuote - victimReceived : 0n,
    attackerProfitBase,
  };
}

/// ---------------------------------------------------------------- LANE B
/// The same victim trade, encrypted and batched.
async function laneB(viem: any, provider: any, wallets: any[]) {
  const deployer = wallets[0].account.address;

  const mockNox = await viem.deployContract("MockNoxCompute");
  const code = await provider.request({
    method: "eth_getCode",
    params: [mockNox.address, "latest"],
  });
  await provider.request({ method: "hardhat_setCode", params: [NOX_COMPUTE_LOCAL, code] });
  const nox = await viem.getContractAt("MockNoxCompute", NOX_COMPUTE_LOCAL);

  const { base, quote, router } = await freshPool(viem, deployer);
  const hashswap = await viem.deployContract("HashSwap", [
    base.address, quote.address, POOL_FEE, router.address, REF_PRICE,
  ]);

  const fairQuote = await router.read.quote([base.address, quote.address, VICTIM_SIZE]);

  // Victim plus two counterparties whose flow offsets most of the victim's.
  const parties: Array<[number, bigint, boolean]> = [
    [7, VICTIM_SIZE, false], // the same victim, same size
    [3, 4n * ONE, true],
    [4, 4n * ONE, true],
  ];

  for (const [idx] of parties) {
    const account = wallets[idx].account;
    await base.write.mint([account.address, 1_000n * ONE]);
    await quote.write.mint([account.address, 2_000_000n * ONE]);
    await base.write.approve([hashswap.address, 1_000n * ONE], { account });
    await quote.write.approve([hashswap.address, 2_000_000n * ONE], { account });
    await hashswap.write.deposit([base.address, 1_000n * ONE], { account });
    await hashswap.write.deposit([quote.address, 2_000_000n * ONE], { account });
  }

  const victim = wallets[7].account.address;
  const victimQuoteBefore = await nox.read.peek([
    await hashswap.read.balanceHandleOf([quote.address, victim]),
  ]);

  for (const [idx, amount, isBuy] of parties) {
    await nox.write.mintExternal([amount, TEE_UINT256]);
    const amountHandle = await nox.read.lastMinted();
    await nox.write.mintExternal([isBuy ? 1n : 0n, TEE_BOOL]);
    const sideHandle = await nox.read.lastMinted();
    await hashswap.write.submitIntent([amountHandle, "0x00", sideHandle, "0x00"], {
      account: wallets[idx].account,
    });
  }

  await provider.request({ method: "evm_increaseTime", params: [120] });
  await provider.request({ method: "evm_mine", params: [] });
  await hashswap.write.closeBatch();

  const batch = await hashswap.read.getBatch([1n]);
  const residual = await nox.read.peek([batch.residualHandle]);
  const isSell = (await nox.read.peek([batch.sellSideHandle])) === 1n;

  const poolBefore = await router.read.reserves([base.address]);
  await hashswap.write.settle([
    1n, residual, `0x${"00".repeat(65)}${residual.toString(16).padStart(64, "0")}`,
    isSell, `0x${"00".repeat(65)}${isSell ? "01" : "00"}`,
  ]);
  const poolAfter = await router.read.reserves([base.address]);

  const victimQuoteAfter = await nox.read.peek([
    await hashswap.read.balanceHandleOf([quote.address, victim]),
  ]);

  return {
    fairQuote,
    victimReceived: victimQuoteAfter - victimQuoteBefore,
    grossVolume: VICTIM_SIZE + 8n * ONE,
    residual,
    poolTouched: poolAfter - poolBefore,
    intentHandle: batch.residualHandle,
  };
}

async function main() {
  const conn = (await network.connect()) as any;
  const { viem, provider } = conn;
  const wallets = await viem.getWalletClients();

  console.log(`\n${bar("═")}`);
  console.log("  HashSwap — the same trade, twice");
  console.log(`  Victim sells ${fmt(VICTIM_SIZE, 0)} BASE into a ${fmt(BASE_RESERVE, 0)} BASE pool`);
  console.log(bar("═"));

  const a = await laneA(viem, wallets);
  console.log("\n  LANE A — naked swap on Uniswap");
  console.log(`  ${bar()}`);
  console.log(`  fair value (empty block)   ${fmt(a.fairQuote).padStart(14)} QUOTE`);
  console.log(`  actually received          ${fmt(a.victimReceived).padStart(14)} QUOTE`);
  console.log(`  \x1b[31mextracted by sandwich      ${fmt(a.lost).padStart(14)} QUOTE\x1b[0m`);
  console.log(`  attacker profit            ${fmt(a.attackerProfitBase, 4).padStart(14)} BASE`);

  const b = await laneB(viem, provider, wallets);
  console.log("\n  LANE B — encrypted intent through HashSwap");
  console.log(`  ${bar()}`);
  console.log(`  what the mempool sees      ${b.intentHandle.slice(0, 22)}…`);
  console.log(`  gross batch volume         ${fmt(b.grossVolume).padStart(14)} BASE`);
  console.log(`  reached the pool           ${fmt(b.poolTouched).padStart(14)} BASE`);
  console.log(`  received                   ${fmt(b.victimReceived).padStart(14)} QUOTE`);
  console.log(`  \x1b[32mextracted by sandwich                0.00 QUOTE\x1b[0m`);

  const saved = b.victimReceived > a.victimReceived ? b.victimReceived - a.victimReceived : 0n;
  const pctInternalised = Number((b.grossVolume - b.poolTouched) * 100n) / Number(b.grossVolume);

  console.log(`\n${bar("═")}`);
  console.log(`  \x1b[1mSAVED  ${fmt(saved)} QUOTE\x1b[0m`);
  console.log(`  ${pctInternalised.toFixed(0)}% of batch volume never touched the public pool`);
  console.log(`${bar("═")}\n`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
