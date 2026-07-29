import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

/// Market maker of last resort.
///
///   npx hardhat run scripts/maker.ts --network sepolia
///
/// Watches every market and, when a batch is short of `MIN_BATCH_SIZE` with its
/// window nearly up, submits balanced two-sided orders so it can clear. Earns
/// the spread configured via `setMaker`.
///
/// ## Why balanced
///
/// The maker posts a buy and a sell of the same size. They cross against each
/// other, so its net position after settlement is roughly flat — it is being
/// paid for *presence*, not for taking directional risk. A one-sided maker would
/// accumulate inventory it has no way to hedge.
///
/// ## What this does NOT buy
///
/// Liveness, not privacy. A maker padding a batch that holds one real user can
/// subtract its own known orders and derive that user's position exactly. The
/// public learns nothing; the maker learns everything. That is the same bargain
/// an RFQ dealer offers and it is only honest if stated plainly — which is why
/// it is stated here, in the contract, and in the README.

const TICK_MS = 10_000;

/// Act once the window is this close to expiring. Waiting gives real users a
/// chance to fill the batch on their own, so the maker only steps in when the
/// alternative is another empty rollover.
const STEP_IN_AT_SEC = 20;

const HS_ABI = [
  "function currentBatchId() view returns (uint256)",
  "function getBatch(uint256) view returns (tuple(uint64 openedAt,uint64 closedAt,uint32 count,uint8 status,bytes32 totalBuy,bytes32 totalSell,bytes32 residualHandle,bytes32 sellSideHandle,uint256 refPrice,uint256 residual,uint256 clearingPrice,bool residualIsSell))",
  "function submitIntent(bytes32,bytes,bytes32,bytes) returns (uint256)",
  "function deposit(address,uint256)",
  "function balanceHandleOf(address,address) view returns (bytes32)",
  "function MIN_BATCH_SIZE() view returns (uint32)",
  "function BATCH_WINDOW() view returns (uint64)",
  "function maker() view returns (address)",
];
const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(30)} ${d}`);

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  await network.connect();

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const key = (process.env.MAKER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
  const signer = new ethers.Wallet("0x" + key.replace(/^0x/, ""), provider);
  const hc = await createEthersHandleClient(signer as any);

  log("maker online", signer.address);

  const markets = registry.markets.map((m: any) => ({
    ...m,
    contract: new ethers.Contract(m.hashswap, HS_ABI, signer),
    baseC: new ethers.Contract(m.base.address, ERC20, signer),
    quoteC: new ethers.Contract(m.quote.address, ERC20, signer),
  }));

  for (const m of markets) {
    const registered = (await m.contract.maker()).toLowerCase();
    const active = registered === signer.address.toLowerCase();
    log(`  ${m.id}`, active ? "registered as maker" : `maker is ${registered.slice(0, 10)}… — not us`);
  }

  // Clip size per market: small enough that the maker's own flow never dominates
  // a batch, large enough that it actually crosses against a real order.
  const clip = (m: any) => 10n ** BigInt(m.base.decimals - 3); // 0.001 base

  for (;;) {
    for (const m of markets) {
      try {
        const id: bigint = await m.contract.currentBatchId();
        const b = await m.contract.getBatch(id);
        if (Number(b.status) !== 0) continue;

        const [minSize, windowSec] = await Promise.all([
          m.contract.MIN_BATCH_SIZE(),
          m.contract.BATCH_WINDOW(),
        ]);

        const count = Number(b.count);
        const remaining = Number(b.openedAt) + Number(windowSec) - Math.floor(Date.now() / 1000);

        // Nothing to rescue: either the batch can already clear, or nobody is in
        // it at all — a batch of only maker orders would be pointless.
        if (count >= Number(minSize)) continue;
        if (count === 0) continue;
        if (remaining > STEP_IN_AT_SEC) continue;

        const missing = Number(minSize) - count;
        log(`${m.id} stepping in`, `${count} orders, ${remaining}s left, adding ${missing}`);

        const size = clip(m);
        const quoteNeeded = (size * BigInt(m.refPrice) * 110n) / (10n ** 18n * 100n);

        // Top up collateral only when short — the vault balance persists between
        // batches, so most of the time this is a no-op.
        const held: bigint = await m.baseC.balanceOf(signer.address);
        if (held >= size * BigInt(missing)) {
          await (await m.baseC.approve(m.hashswap, size * BigInt(missing))).wait();
          await (await m.contract.deposit(m.base.address, size * BigInt(missing))).wait();
        }
        const heldQ: bigint = await m.quoteC.balanceOf(signer.address);
        if (heldQ >= quoteNeeded * BigInt(missing)) {
          await (await m.quoteC.approve(m.hashswap, quoteNeeded * BigInt(missing))).wait();
          await (await m.contract.deposit(m.quote.address, quoteNeeded * BigInt(missing))).wait();
        }

        // Alternate sides so the maker's own orders cross against each other and
        // it ends the batch roughly flat.
        for (let i = 0; i < missing; i++) {
          const isBuy = i % 2 === 0;
          const a = await hc.encryptInput(size, "uint256", m.hashswap);
          const s = await hc.encryptInput(isBuy, "bool", m.hashswap);
          const r = await (
            await m.contract.submitIntent(a.handle, a.handleProof, s.handle, s.handleProof)
          ).wait();
          log(`  ${isBuy ? "buy " : "sell"} ${ethers.formatUnits(size, m.base.decimals)}`, `gas ${r.gasUsed}`);
        }
      } catch (e: any) {
        log(`${m.id} error`, (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 70));
      }
    }
    await sleep(TICK_MS);
  }
}

main().catch((e) => {
  console.error("maker died:", e);
  process.exitCode = 1;
});
