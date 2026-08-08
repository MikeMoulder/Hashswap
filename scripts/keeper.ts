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
  "function pendingSettlement() view returns (uint256)",
  "function getBatch(uint256) view returns (tuple(uint64 openedAt,uint64 closedAt,uint32 count,uint8 status,bytes32 totalBuy,bytes32 totalSell,bytes32 residualHandle,bytes32 sellSideHandle,uint256 refPrice,uint256 residual,uint256 clearingPrice,bool residualIsSell, address maker, uint16 makerFeeBps))",
  "function settle(uint256,uint256,bytes,bool,bytes)",
  "function cancelBatch(uint256)",
  "function closeBatch()",
  "function MIN_BATCH_SIZE() view returns (uint32)",
  "function BATCH_WINDOW() view returns (uint64)",
  "function SETTLE_TIMEOUT() view returns (uint64)",
  "function MAX_PRICE_DEVIATION_BPS() view returns (uint16)",
];

/// Uniswap's quoter, used only to pre-check a settlement.
///
/// `settle` derives its own bounds on-chain and this process cannot widen them
/// — see the trust note above. This is the same arithmetic run off-chain, for
/// one reason: to tell a batch that *cannot* clear from one that simply has not
/// been tried yet. Without it every doomed batch costs two gateway decryptions
/// and a settle attempt on every tick until the cancel timeout — roughly 200
/// round-trips against the flakiest dependency in the system, to fail the same
/// way each time, and reporting Uniswap's opaque "STF" rather than the real
/// reason.
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160,uint32,uint256)",
];

const WAD = 10n ** 18n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(30)} ${d}`);

/// Does the deployed bytecode carry `pendingSettlement`?
///
/// It was added after the Sepolia markets were deployed, so the live contracts
/// still close a batch *in place* and only open the successor once that batch
/// settles. A keeper that assumes the newer layout calls a selector the
/// bytecode does not implement, which returns no data at all — ethers reports
/// that as `CALL_EXCEPTION` with `data: null`, the "missing revert data" that
/// took every tick down before it reached `closeBatch`.
///
/// Probed once at startup rather than assumed, because both layouts are live:
/// this host talks to the old one, a fresh deploy is the new one, and the
/// difference is invisible in the ABI.
///
/// Only a dataless CALL_EXCEPTION means "absent". An RPC timeout looks like a
/// failure too, and treating that as absence would silently downgrade a
/// correctly deployed market to the legacy path for the life of the process.
async function hasPendingSlot(c: ethers.Contract): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await c.pendingSettlement();
      return true;
    } catch (e: any) {
      if (e?.code === "CALL_EXCEPTION" && e?.data == null) return false;
      if (attempt >= 2) throw e;
      await sleep(2000);
    }
  }
}

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
    m.settleTimeout = Number(await m.contract.SETTLE_TIMEOUT());
    m.hasPending = await hasPendingSlot(m.contract);
    m.devBps = BigInt(await m.contract.MAX_PRICE_DEVIATION_BPS());
  }

  const quoter = new ethers.Contract(registry.uniswap.quoterV2, QUOTER_ABI, provider);

  log("keeper online", `${markets.length} markets, ${signer.address.slice(0, 10)}…`);
  for (const m of markets) {
    log(`  watching ${m.id}`, `${m.hashswap}${m.hasPending ? "" : " (legacy: no pendingSettlement)"}`);
  }

  /// Can this residual execute inside the band `settle` will impose?
  ///
  /// Mirrors the on-chain arithmetic: a sell must fetch at least `refPrice`
  /// less the deviation, a buy must cost no more than `refPrice` plus it.
  ///
  /// `null` means "could not tell" — a quoter hiccup must not be able to block a
  /// settlement that would have worked, so the caller tries anyway on null.
  async function withinBand(m: any, b: any, amount: bigint, isSell: boolean) {
    const ref: bigint = BigInt(b.refPrice);
    const dev: bigint = BigInt(m.devBps);

    // The contract skips the pool entirely when the residual is worth less than
    // one wei of quote, and settles at the reference price. Nothing to quote.
    if ((amount * ref) / WAD === 0n) return true;

    const params = { fee: m.fee, sqrtPriceLimitX96: 0 };
    try {
      if (isSell) {
        const floor = (amount * ((ref * (10_000n - dev)) / 10_000n)) / WAD;
        const [out] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: m.base.address,
          tokenOut: m.quote.address,
          amountIn: amount,
          ...params,
        });
        if (out >= floor) return true;
        log(
          `${m.id} outside band`,
          `sell fetches ${ethers.formatUnits(out, m.quote.decimals).slice(0, 10)}, floor is ${ethers.formatUnits(floor, m.quote.decimals).slice(0, 10)} ${m.quote.symbol}`,
        );
        return false;
      }

      const ceiling = (amount * ((ref * (10_000n + dev)) / 10_000n)) / WAD;
      const [inn] = await quoter.quoteExactOutputSingle.staticCall({
        tokenIn: m.quote.address,
        tokenOut: m.base.address,
        amount,
        ...params,
      });
      if (inn <= ceiling) return true;
      log(
        `${m.id} outside band`,
        `buy costs ${ethers.formatUnits(inn, m.quote.decimals).slice(0, 10)}, ceiling is ${ethers.formatUnits(ceiling, m.quote.decimals).slice(0, 10)} ${m.quote.symbol}`,
      );
      return false;
    } catch (e: any) {
      log(`${m.id} quote failed`, (e?.shortMessage ?? e?.message ?? "").slice(0, 60));
      return null;
    }
  }

  /// Plaintext residuals, keyed `market#batchId`.
  ///
  /// A batch's residual is fixed the moment it closes, so decrypting it more
  /// than once is waste — and not cheap waste: it is two gateway round-trips,
  /// on the one dependency most likely to be down. A batch that cannot settle
  /// is retried until the cancel timeout, so without this the keeper re-asks
  /// the gateway for an answer it already has, every tick, for an hour.
  const plaintext = new Map<string, { amount: bigint; residualProof: string; sideProof: string; isSell: boolean }>();

  /// Settle a closed batch, or cancel it once the timeout is up.
  ///
  /// Returns true when the batch is no longer outstanding — settled, cancelled,
  /// or already neither. False means it is still owed a settlement and nothing
  /// else may happen on this market until it is.
  async function clearBatch(m: any, id: bigint, b: any): Promise<boolean> {
    const age = Math.floor(Date.now() / 1000) - Number(b.closedAt);

    const cacheKey = `${m.id}#${id}`;
    let known = plaintext.get(cacheKey);
    if (!known) {
      try {
        const residual = await resolve(hc, b.residualHandle, "residual");
        const side = await resolve(hc, b.sellSideHandle, "direction");
        known = {
          amount: BigInt(residual.value as any),
          residualProof: residual.proof,
          sideProof: side.proof,
          isSell: Boolean(side.value),
        };
        plaintext.set(cacheKey, known);
      } catch (e: any) {
        log(`${m.id} batch ${id} unresolved`, e.message);
      }
    }

    // Ask the pool before asking the chain. The band is drawn around a
    // reference price fixed when the batch opened, so a pool that has moved
    // further than the band is wide makes this batch permanently unsettleable —
    // but only *probably* permanently: the pool can move back, so keep checking
    // rather than giving up, and let the timeout below do the refunding.
    if (known && (await withinBand(m, b, known.amount, known.isSell)) !== false) {
      const { amount, isSell } = known;
      log(
        `${m.id} settling ${id}`,
        `${ethers.formatUnits(amount, m.base.decimals)} ${m.base.symbol} ${isSell ? "sell" : "buy"}`,
      );
      try {
        // No slippage argument: the contract computes the bound itself from the
        // batch's reference price. A settlement that cannot execute inside that
        // band reverts here, and the cancel below refunds it once the timeout
        // elapses — refusing to trade is the correct outcome, so this failing is
        // not a keeper fault.
        const receipt = await (
          await m.contract.settle(id, amount, known.residualProof, isSell, known.sideProof)
        ).wait();
        const after = await m.contract.getBatch(id);
        const price = ethers.formatUnits(
          after.clearingPrice,
          18 + m.base.decimals - m.quote.decimals,
        );
        log(`${m.id} batch ${id} settled`, `gas ${receipt.gasUsed}, price ${price} ${m.quote.symbol}`);
        plaintext.delete(cacheKey);
        return true;
      } catch (e: any) {
        log(`${m.id} batch ${id} unsettleable`, (e?.shortMessage ?? e?.message ?? "").slice(0, 70));
      }
    }

    // A batch that cannot settle has to be cleared, not merely reported. Until
    // it is, participants stay collateralised and no further batch can close.
    // This used to be left to a human; the contract has always allowed anyone
    // to call it, so there is no reason it should be.
    if (age >= m.settleTimeout) {
      log(`${m.id} cancelling ${id}`, `stuck ${age}s, refunding participants`);
      await (await m.contract.cancelBatch(id)).wait();
      plaintext.delete(cacheKey);
      return true;
    }

    log(`${m.id} batch ${id} waiting`, `cancellable in ${m.settleTimeout - age}s`);
    return false;
  }

  /// Close an open batch once its window is up. Below MIN_BATCH_SIZE the
  /// contract rolls the window over instead, so calling close is harmless but
  /// pointless.
  async function closeIfReady(m: any, id: bigint, b: any) {
    const { minSize, windowSec } = m; // read once at startup
    const elapsed = Math.floor(Date.now() / 1000) - Number(b.openedAt);
    if (Number(b.count) >= minSize && elapsed >= windowSec) {
      log(`${m.id} closing batch ${id}`, `${b.count} orders`);
      await (await m.contract.closeBatch()).wait();
    }
  }

  for (;;) {
    for (const m of markets) {
      try {
        if (m.hasPending) {
          // Settlement first, always. `closeBatch` reverts while a batch is
          // still owed a settlement, so a keeper that closed first would spend
          // every tick bouncing off its own outstanding batch and never reach
          // the settle that would release it.
          const pending: bigint = await m.contract.pendingSettlement();
          if (pending !== 0n) {
            const b = await m.contract.getBatch(pending);
            if (!(await clearBatch(m, pending, b))) continue;
          }

          const current: bigint = await m.contract.currentBatchId();
          const b = await m.contract.getBatch(current);
          if (Number(b.status) === 0) await closeIfReady(m, current, b);
          continue;
        }

        // Legacy layout: closing does not open a successor, so the batch owed a
        // settlement *is* `currentBatchId` until it clears. Both `settle` and
        // `cancelBatch` reject anything else outright, so there is nothing to
        // gain by sweeping older ids — whatever state they are in, this keeper
        // has no call that would move them.
        const current: bigint = await m.contract.currentBatchId();
        const b = await m.contract.getBatch(current);
        const status = Number(b.status);

        if (status === 1) await clearBatch(m, current, b);
        else if (status === 0) await closeIfReady(m, current, b);
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
