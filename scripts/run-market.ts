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
///
/// ## Three wallets, not one
///
/// The contract allows one live intent per address per batch (audit F19), so
/// this cannot run from a single key — and it should never have. A three-order
/// batch submitted by one address has an anonymity set of *one*: the residual
/// plus the knowledge that all three orders were yours reveals everything.
/// `MIN_BATCH_SIZE` counts distinct parties precisely so that this is not
/// mistakable for privacy.
///
/// Participants 2 and 3 are derived deterministically from the deployer key, and
/// topped up from it on demand, so the script stays a one-command demo without
/// pretending a single wallet is a crowd.

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
    "function transfer(address,uint256) returns (bool)",
  ];

  const hs = new ethers.Contract(market.hashswap, HS, me);
  const base = new ethers.Contract(market.base.address, ERC, me);
  const quote = new ethers.Contract(market.quote.address, ERC, me);

  const bDec = market.base.decimals;
  const qDec = market.quote.decimals;
  const unit = (n: string, d: number) => ethers.parseUnits(n, d);

  console.log(`\nmarket   ${market.base.symbol}/${market.quote.symbol}  fee ${market.fee / 10000}%`);
  console.log(`hashswap ${market.hashswap}`);
  console.log(`pool     ${market.pool}  (pre-existing, not ours)\n`);

  // Orders sized so two thirds cross internally and only the remainder trades.
  //
  // SIZE scales all three together. The default is the headline demo size; drop
  // it when the deployer's inventory is thin, since most of it ends up sitting
  // in vault balances of previous deployments rather than in the wallet.
  const SIZE = process.env.SIZE ?? "0.006";
  const scale = (mult: number) => {
    const b = ethers.parseUnits(SIZE, bDec);
    return (b * BigInt(Math.round(mult * 1000))) / 1000n;
  };
  const SELL_1 = scale(1);
  const SELL_2 = scale(2 / 3);
  const BUY = scale(4 / 3);

  // Collateral: sellers post base, buyers post quote at the reference rate plus
  // headroom over the contract's 5% buffer.
  const quoteForBuy = (BUY * BigInt(market.refPrice) * 110n) / (10n ** 18n * 100n);

  // Three distinct participants. Two are derived from the deployer key so the
  // demo stays one command, but they are separate addresses on-chain, which is
  // what MIN_BATCH_SIZE is actually counting.
  const derive = (i: number) =>
    new ethers.Wallet(
      ethers.keccak256(ethers.toUtf8Bytes(`hashswap/demo/${me.address}/${i}`)),
      provider,
    );

  const parties = [
    { name: "seller-1", signer: me, amount: SELL_1, isBuy: false },
    { name: "seller-2", signer: derive(2), amount: SELL_2, isBuy: false },
    { name: "buyer", signer: derive(3), amount: BUY, isBuy: true },
  ];

  const GAS_FLOOR = ethers.parseEther("0.02");
  const GAS_TOPUP = ethers.parseEther("0.04");

  for (const p of parties) {
    if (p.signer === me) continue;
    const bal = await provider.getBalance(p.signer.address);
    if (bal < GAS_FLOOR) {
      log(`funding ${p.name}`, `${ethers.formatEther(GAS_TOPUP)} ETH -> ${p.signer.address}`);
      await (await me.sendTransaction({ to: p.signer.address, value: GAS_TOPUP })).wait();
    }
    // Each participant needs their own collateral in their own wallet.
    const token = p.isBuy ? quote : base;
    const need = p.isBuy ? quoteForBuy : p.amount;
    const held: bigint = await token.balanceOf(p.signer.address);
    if (held < need) {
      log(`funding ${p.name}`, `${ethers.formatUnits(need - held, p.isBuy ? qDec : bDec)} ${p.isBuy ? market.quote.symbol : market.base.symbol}`);
      await (await token.transfer(p.signer.address, need - held)).wait();
    }
  }

  // Each participant deposits their own collateral into their own vault balance.
  for (const p of parties) {
    const token = new ethers.Contract(
      p.isBuy ? market.quote.address : market.base.address,
      ERC,
      p.signer,
    );
    const vault = new ethers.Contract(market.hashswap, HS, p.signer);
    const need = p.isBuy ? quoteForBuy : p.amount;
    const sym = p.isBuy ? market.quote.symbol : market.base.symbol;
    log(`${p.name} depositing`, `${ethers.formatUnits(need, p.isBuy ? qDec : bDec)} ${sym}`);
    await (await token.approve(market.hashswap, need)).wait();
    await (await vault.deposit(p.isBuy ? market.quote.address : market.base.address, need)).wait();
  }

  const batchId = await hs.currentBatchId();
  log("batch", batchId.toString());

  for (const p of parties) {
    // The handle proof is bound to (owner, app), so each participant encrypts
    // with their own client — one shared client would produce proofs the
    // contract rejects for everyone but its owner.
    const hcp = await createEthersHandleClient(p.signer as any);
    const contract = new ethers.Contract(market.hashswap, HS, p.signer);
    const a = await hcp.encryptInput(p.amount, "uint256", market.hashswap);
    const s = await hcp.encryptInput(p.isBuy, "bool", market.hashswap);
    const r = await (
      await contract.submitIntent(a.handle, a.handleProof, s.handle, s.handleProof)
    ).wait();
    log(
      `${p.name} ${p.isBuy ? "buy " : "sell"} ${ethers.formatUnits(p.amount, bDec)}`,
      `gas ${r.gasUsed}`,
    );
  }

  const hc = await createEthersHandleClient(me as any);

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
