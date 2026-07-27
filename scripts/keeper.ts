import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient, NotYetComputedHandleError } from "@iexec-nox/handle";

/// The off-chain half of settlement.
///
/// Settlement is two transactions because Uniswap takes a plain `uint256` and
/// the residual is encrypted (build.md §2.2). `closeBatch` publishes the residual
/// handle; something off-chain must fetch the plaintext plus a gateway signature
/// and hand both back to `settle`.
///
/// ## What the keeper is and is not trusted for
///
/// NOT trusted for the value: `settle` verifies the gateway's signature on-chain
/// via `Nox.publicDecrypt`, so a forged residual reverts (invariant I7, proven on
/// Sepolia). It IS trusted for liveness and ordering — it chooses *when* to
/// submit, so it can position its own transaction around the settlement swap.
/// The `minOut` bound is what limits that, and removing the ordering trust
/// entirely needs commit-reveal or a permissionless keeper set (build.md F6).
///
/// ## Polling
///
/// Measured on Sepolia: a freshly-computed handle becomes decryptable after
/// ~7 seconds, typically on the second attempt. The Runner computes off-chain
/// after the transaction lands, so the first call reliably fails. That is
/// expected, not an error — do not treat it as one.
///
/// Usage:
///   npx hardhat run scripts/keeper.ts --network sepolia

const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 2000);
const MAX_WAIT_MS = Number(process.env.KEEPER_MAX_WAIT_MS ?? 120_000);
const TICK_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string, detail = "") {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${msg.padEnd(26)} ${detail}`);
}

type Dep = { contracts: { hashswap: string } };

/// Poll until the Runner has computed the handle, or give up.
///
/// Backs off geometrically. `NotYetComputedHandleError` is the expected early
/// state; anything else is logged by class name so an unexpected failure is
/// distinguishable from ordinary waiting.
async function awaitHandle(
  hc: any,
  handle: `0x${string}`,
  label: string,
): Promise<{ value: bigint; decryptionProof: `0x${string}` }> {
  const started = Date.now();
  let delay = POLL_INTERVAL_MS;

  while (Date.now() - started < MAX_WAIT_MS) {
    try {
      const res = await hc.publicDecrypt(handle);
      log(`${label} decrypted`, `${Date.now() - started}ms`);
      return {
        value: BigInt(res.value as any),
        decryptionProof: res.decryptionProof as `0x${string}`,
      };
    } catch (e: any) {
      const kind =
        e instanceof NotYetComputedHandleError
          ? "not yet computed"
          : (e?.constructor?.name ?? "error");
      log(`${label} waiting`, `${kind} (${Date.now() - started}ms)`);
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.5), 15_000);
    }
  }
  throw new Error(`${label}: handle never resolved within ${MAX_WAIT_MS}ms`);
}

async function main() {
  const dep: Dep = JSON.parse(
    readFileSync(`deployments/${process.env.HARDHAT_NETWORK ?? "sepolia"}.json`, "utf8"),
  );

  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const hashswap = await viem.getContractAt("HashSwap", dep.contracts.hashswap);

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const signer = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );
  const hc = await createEthersHandleClient(signer as any);

  log("keeper online", hashswap.address);

  const settled = new Set<string>();

  for (;;) {
    try {
      const batchId: bigint = await hashswap.read.currentBatchId();

      // Sweep the current batch and a few behind it: closing opens a new batch,
      // so the one needing settlement is usually already historical.
      for (let id = batchId; id > 0n && id > batchId - 5n; id--) {
        if (settled.has(id.toString())) continue;

        const batch = await hashswap.read.getBatch([id]);
        const status = Number(batch.status);

        // 0 Open · 1 Closed · 2 Settled · 3 Cancelled
        if (status === 2 || status === 3) {
          settled.add(id.toString());
          continue;
        }
        if (status !== 1) continue;

        log(`batch ${id} closed`, "resolving residual");

        let residual: { value: bigint; decryptionProof: `0x${string}` };
        let side: { value: bigint; decryptionProof: `0x${string}` };
        try {
          residual = await awaitHandle(hc, batch.residualHandle, "residual");
          side = await awaitHandle(hc, batch.sellSideHandle, "direction");
        } catch (e: any) {
          // Unresolvable handle. Do not spin: the on-chain cancel path exists
          // precisely so a stuck batch refunds instead of locking funds
          // (build.md F4). Leave it for `cancelBatch` once the timeout elapses.
          log(`batch ${id} STUCK`, e.message);
          continue;
        }

        const isSell = side.value !== 0n;

        // TODO(build.md F6): derive this from the pool's `observe` TWAP. A zero
        // bound means the keeper's own ordering is unconstrained, which is
        // acceptable against a mock pool and NOT acceptable against a real one.
        const limitAmount = isSell ? 0n : ethers.MaxUint256;

        log(
          `settling ${id}`,
          `${ethers.formatEther(residual.value)} base, ${isSell ? "sell" : "buy"}`,
        );

        const hash = await hashswap.write.settle([
          id,
          residual.value,
          residual.decryptionProof,
          isSell,
          side.decryptionProof,
          limitAmount,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        const after = await hashswap.read.getBatch([id]);
        log(`batch ${id} settled`, `gas ${receipt.gasUsed}, price ${after.clearingPrice}`);
        settled.add(id.toString());
      }
    } catch (e: any) {
      log("tick error", e?.shortMessage ?? e?.message ?? String(e));
    }

    await sleep(TICK_MS);
  }
}

main().catch((e) => {
  console.error("keeper died:", e);
  process.exitCode = 1;
});
