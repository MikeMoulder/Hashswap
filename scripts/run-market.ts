import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient, NotYetComputedHandleError } from "@iexec-nox/handle";

/// Run a complete batch on a real-token market, end to end.
///
///   MARKET=WETH-LINK npx hardhat run scripts/run-market.ts --network sepolia
///
/// Deposit -> three sealed orders -> close -> resolve the residual -> settle
/// against the live Uniswap pool. This is the whole product against real tokens
/// in a pool we neither created nor control.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(26)} ${d}`);

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  const id = process.env.MARKET ?? "WETH-LINK";
  const market = registry.markets.find((m: any) => m.id === id);
  if (!market) throw new Error(`unknown market ${id}`);

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const me = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );

  const HS = [
    "function deposit(address,uint256)",
    "function submitIntent(bytes32,bytes,bytes32,bytes) returns (uint256)",
    "function closeBatch()",
    "function settle(uint256,uint256,bytes,bool,bytes)",
    "function currentBatchId() view returns (uint256)",
    "function getBatch(uint256) view returns (tuple(uint64,uint64,uint32,uint8,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bool,address,uint16))",
  ];
  const ERC = [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ];

  const hs = new ethers.Contract(market.hashswap, HS, me);
  const base = new ethers.Contract(market.base.address, ERC, me);
  const quote = new ethers.Contract(market.quote.address, ERC, me);
  const hc = await createEthersHandleClient(me as any);

  const bDec = market.base.decimals;
  const qDec = market.quote.decimals;
  const unit = (n: string, d: number) => ethers.parseUnits(n, d);

  console.log(`\nmarket   ${market.base.symbol}/${market.quote.symbol}  fee ${market.fee / 10000}%`);
  console.log(`hashswap ${market.hashswap}`);
  console.log(`pool     ${market.pool}  (pre-existing, not ours)\n`);

  // Orders sized so two thirds cross internally and only the remainder trades.
  const SELL_1 = unit("0.006", bDec);
  const SELL_2 = unit("0.004", bDec);
  const BUY = unit("0.008", bDec);

  // Collateral: sellers post base, buyers post quote at the reference rate plus
  // the contract's 5% buffer.
  const baseNeeded = SELL_1 + SELL_2;
  const quoteNeeded = (BUY * BigInt(market.refPrice) * 110n) / (10n ** 18n * 100n);

  log("depositing base", ethers.formatUnits(baseNeeded, bDec) + " " + market.base.symbol);
  await (await base.approve(market.hashswap, baseNeeded)).wait();
  await (await hs.deposit(market.base.address, baseNeeded)).wait();

  log("depositing quote", ethers.formatUnits(quoteNeeded, qDec) + " " + market.quote.symbol);
  await (await quote.approve(market.hashswap, quoteNeeded)).wait();
  await (await hs.deposit(market.quote.address, quoteNeeded)).wait();

  const batchId = await hs.currentBatchId();
  log("batch", batchId.toString());

  for (const [amount, isBuy] of [
    [SELL_1, false],
    [SELL_2, false],
    [BUY, true],
  ] as const) {
    const a = await hc.encryptInput(amount, "uint256", market.hashswap);
    const s = await hc.encryptInput(isBuy, "bool", market.hashswap);
    const r = await (await hs.submitIntent(a.handle, a.handleProof, s.handle, s.handleProof)).wait();
    log(`${isBuy ? "buy " : "sell"} ${ethers.formatUnits(amount, bDec)}`, `gas ${r.gasUsed}`);
  }

  log("waiting window", "65s");
  await sleep(65_000);
  await (await hs.closeBatch()).wait();
  log("closed");

  const b = await hs.getBatch(batchId);
  if (Number(b[3]) !== 1) throw new Error(`batch not Closed (status ${b[3]})`);

  // Residual resolution — the Runner computes off-chain after the tx lands.
  let residual: bigint | undefined;
  let proof: string | undefined;
  for (let i = 0; i < 20 && residual === undefined; i++) {
    try {
      const r = await hc.publicDecrypt(b[6]);
      residual = BigInt(r.value as any);
      proof = r.decryptionProof as string;
    } catch (e: any) {
      log("resolving residual", e instanceof NotYetComputedHandleError ? "not yet" : "retry");
      await sleep(3000);
    }
  }
  if (residual === undefined) throw new Error("residual never resolved");

  const side = await hc.publicDecrypt(b[7]);
  const isSell = Boolean(side.value);
  log("residual", `${ethers.formatUnits(residual, bDec)} ${market.base.symbol}, ${isSell ? "sell" : "buy"}`);

  const poolBase = new ethers.Contract(market.base.address, ERC, provider);
  const before: bigint = await poolBase.balanceOf(market.pool);

  const r = await (
    await hs.settle(batchId, residual, proof, isSell, side.decryptionProof)
  ).wait();
  log("settled", `gas ${r.gasUsed}`);

  const after: bigint = await poolBase.balanceOf(market.pool);
  const settled = await hs.getBatch(batchId);

  const gross = SELL_1 + SELL_2 + BUY;
  const delta = after > before ? after - before : before - after;

  console.log(`\n=========== ${market.base.symbol}/${market.quote.symbol} ===========`);
  console.log(`gross order flow   ${ethers.formatUnits(gross, bDec)} ${market.base.symbol}`);
  console.log(`reached the pool   ${ethers.formatUnits(delta, bDec)} ${market.base.symbol}`);
  console.log(`internalised       ${(100 - Number((delta * 10000n) / gross) / 100).toFixed(1)}%`);
  console.log(`clearing price     ${ethers.formatUnits(settled[10], 18 + bDec - qDec)} ${market.quote.symbol}`);
  console.log(`pool balance moved by exactly the residual — real Uniswap, real tokens`);
  console.log("=========================================\n");
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
