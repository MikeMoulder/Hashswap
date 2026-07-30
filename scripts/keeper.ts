import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient, NotYetComputedHandleError } from "@iexec-nox/handle";

/// The off-chain half of settlement, across every market.
///
///   npx hardhat run scripts/keeper.ts --network sepolia
///
/// Settlement is two transactions because Uniswap takes a plain uint256 and the
/// residual is encrypted. `closeBatch` publishes a handle; something off-chain
/// must fetch the plaintext plus a gateway signature and hand both to `settle`.
///
/// ## Trust
///
/// NOT trusted for the value — `settle` verifies the gateway's signature
/// on-chain via `Nox.publicDecrypt`, so a forged residual reverts. NOT trusted
/// for the execution price either: `settle` derives its own slippage bounds from
/// the batch's reference price, so this process cannot widen them. It used to
/// pass `minOut`/`maxIn` itself, which meant a keeper (or anyone else, since
/// `settle` is permissionless) could hand the pool an unbounded order and settle
/// into a price no buyer had funded.
///
/// It IS still trusted for liveness and ordering: it chooses *when* to submit.
/// The price band bounds what that ordering is worth; removing the trust
/// entirely needs commit-reveal or a permissionless keeper set.
///
/// ## Why it sweeps every market
///
/// Each market is a separate HashSwap deployment (base/quote/fee are immutable),
/// so one keeper process watches several contracts rather than one.

const POLL_MS = Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 2500);
const MAX_WAIT_MS = Number(process.env.KEEPER_MAX_WAIT_MS ?? 120_000);
const TICK_MS = 15_000;

const HS_ABI = [
  "function currentBatchId() view returns (uint256)",
  "function getBatch(uint256) view returns (tuple(uint64 openedAt,uint64 closedAt,uint32 count,uint8 status,bytes32 totalBuy,bytes32 totalSell,bytes32 residualHandle,bytes32 sellSideHandle,uint256 refPrice,uint256 residual,uint256 clearingPrice,bool residualIsSell, address maker, uint16 makerFeeBps))",
  "function settle(uint256,uint256,bytes,bool,bytes)",
  "function closeBatch()",
  "function MIN_BATCH_SIZE() view returns (uint32)",
  "function BATCH_WINDOW() view returns (uint64)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(30)} ${d}`);

/// Poll until the Runner has computed the handle. A freshly written handle is
/// never readable immediately — measured at ~7s on Sepolia — so the first
/// attempt reliably fails and that is expected, not an error.
async function resolve(hc: any, handle: string, label: string) {
  const started = Date.now();
  let delay = POLL_MS;
  while (Date.now() - started < MAX_WAIT_MS) {
    try {
      const r = await hc.publicDecrypt(handle);
      log(`${label} resolved`, `${Date.now() - started}ms`);
      return { value: r.value, proof: r.decryptionProof as string };
    } catch (e: any) {
      const why = e instanceof NotYetComputedHandleError ? "not yet computed" : (e?.message ?? "error");
      log(`${label} waiting`, `${why.slice(0, 60)}`);
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.4), 12_000);
    }
  }
  throw new Error(`${label} never resolved within ${MAX_WAIT_MS}ms`);
}

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  await network.connect();

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  // The keeper holds no capital and cannot steal — the residual it submits is
  // signature-verified on-chain — so it runs on its own hot key, separate from
  // the deployer's admin key.
  //
  // No fallback to the deployer key, deliberately. This process is built to run
  // unattended on a hot host, and the deployer key is the contract `owner` — it
  // can install a maker, set fees, and holds the inventory. Falling back to it
  // would mean a single missing environment variable silently puts the admin key
  // on an internet-facing box, with everything still appearing to work. Refusing
  // to start is the safe failure.
  const key = (process.env.KEEPER_PRIVATE_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "KEEPER_PRIVATE_KEY is not set. Set it explicitly — this process must never " +
        "run as the deployer. Copy only KEEPER_PRIVATE_KEY and SEPOLIA_RPC_URL to " +
        "the host, not the whole .env.",
    );
  }
  const signer = new ethers.Wallet("0x" + key.replace(/^0x/, ""), provider);
  const hc = await createEthersHandleClient(signer as any);

  const markets = registry.markets.map((m: any) => ({
    ...m,
    contract: new ethers.Contract(m.hashswap, HS_ABI, signer),
  }));

  // MIN_BATCH_SIZE and BATCH_WINDOW are Solidity `constant`s — compiled into the
  // bytecode, unable to change. Reading them every tick, per market, was most of
  // this process's RPC traffic and bought nothing.
  for (const m of markets) {
    m.minSize = Number(await m.contract.MIN_BATCH_SIZE());
    m.windowSec = Number(await m.contract.BATCH_WINDOW());
  }

  log("keeper online", `${markets.length} markets, ${signer.address.slice(0, 10)}…`);
  for (const m of markets) log(`  watching ${m.id}`, m.hashswap);

  const done = new Set<string>();

  for (;;) {
    for (const m of markets) {
      const key = (id: bigint) => `${m.id}#${id}`;
      try {
        const current: bigint = await m.contract.currentBatchId();

        // Closing opens a new batch, so the one needing settlement is usually
        // already historical — sweep a few back.
        for (let id = current; id > 0n && id > current - 4n; id--) {
          if (done.has(key(id))) continue;

          const b = await m.contract.getBatch(id);
          const status = Number(b.status);

          if (status === 2 || status === 3) {
            done.add(key(id));
            continue;
          }

          // Close a batch whose window has elapsed and which has enough
          // participants to hide them. Below MIN_BATCH_SIZE the contract rolls
          // over instead, so calling close is harmless but pointless.
          if (status === 0) {
            const { minSize, windowSec } = m; // read once at startup
            const elapsed = Math.floor(Date.now() / 1000) - Number(b.openedAt);
            if (Number(b.count) >= minSize && elapsed >= windowSec) {
              log(`${m.id} closing batch ${id}`, `${b.count} orders`);
              await (await m.contract.closeBatch()).wait();
            }
            continue;
          }

          // status === 1, Closed and awaiting settlement.
          log(`${m.id} batch ${id} closed`, "resolving residual");

          let residual, side;
          try {
            residual = await resolve(hc, b.residualHandle, "residual");
            side = await resolve(hc, b.sellSideHandle, "direction");
          } catch (e: any) {
            // Do not spin. `cancelBatch` exists precisely so a stuck batch
            // refunds rather than locking funds.
            log(`${m.id} batch ${id} STUCK`, e.message);
            continue;
          }

          const amount = BigInt(residual.value as any);
          const isSell = Boolean(side.value);

          log(
            `${m.id} settling ${id}`,
            `${ethers.formatUnits(amount, m.base.decimals)} ${m.base.symbol} ${isSell ? "sell" : "buy"}`,
          );

          // No slippage argument: the contract computes the bound itself from
          // the batch's reference price. A settlement that cannot execute inside
          // that band reverts here, and `cancelBatch` refunds the batch once the
          // timeout elapses — refusing to trade is the correct outcome, so this
          // failing is not a keeper fault.
          const receipt = await (
            await m.contract.settle(id, amount, residual.proof, isSell, side.proof)
          ).wait();

          const after = await m.contract.getBatch(id);
          const price = ethers.formatUnits(
            after.clearingPrice,
            18 + m.base.decimals - m.quote.decimals,
          );
          log(`${m.id} batch ${id} settled`, `gas ${receipt.gasUsed}, price ${price} ${m.quote.symbol}`);
          done.add(key(id));
        }
      } catch (e: any) {
        log(`${m.id} tick error`, (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 80));
      }
    }
    await sleep(TICK_MS);
  }
}

main().catch((e) => {
  console.error("keeper died:", e);
  process.exitCode = 1;
});
