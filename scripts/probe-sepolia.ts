import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
// NOTE: the SDK's .d.ts declares more error classes than it actually exports at
// runtime (SubgraphOutOfSyncError and GatewayTrustError are type-only). Importing
// them is a hard ESM failure, so match them by name instead.
import { createEthersHandleClient, NotYetComputedHandleError } from "@iexec-nox/handle";

/// The experiment that retires the project's biggest risk.
///
/// Every one of the 43 local tests runs against MockNoxCompute — a model of Nox
/// that I wrote. That is circular: it proves the contracts agree with my
/// assumptions, not with reality. This script runs one full batch against the
/// REAL NoxCompute singleton and the REAL Handle Gateway and answers the four
/// questions the mock cannot:
///
///   1. Does `encryptInput` -> `fromExternal` -> ACL actually work end to end?
///   2. **How long after `closeBatch` is the residual decryptable?** (build.md F3)
///      The mock resolves synchronously; the real Runner computes off-chain
///      afterwards. This number sets the keeper's polling strategy and the
///      demo's pacing.
///   3. What does a Nox op really cost in gas? That sets MAX_BATCH_SIZE.
///   4. Do decryption proofs verify on-chain? (invariant I7)
///
/// Uses one wallet for all three intents. That satisfies MIN_BATCH_SIZE but is
/// NOT a real anonymity set — this measures plumbing, not privacy.

const ONE = 10n ** 18n;
const TIMEOUT_MS = 5 * 60 * 1000;

type Dep = {
  contracts: { base: string; quote: string; router: string; hashswap: string };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(step: string, detail = "") {
  console.log(`${new Date().toISOString().slice(11, 23)}  ${step.padEnd(28)} ${detail}`);
}

async function main() {
  const dep: Dep = JSON.parse(readFileSync("deployments/sepolia.json", "utf8"));
  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me = wallet.account.address as `0x${string}`;

  const hashswap = await viem.getContractAt("HashSwap", dep.contracts.hashswap);
  const base = await viem.getContractAt("MockERC20", dep.contracts.base);
  const quote = await viem.getContractAt("MockERC20", dep.contracts.quote);

  const send = async (label: string, p: Promise<`0x${string}`>) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await p });
    log(label, `gas ${receipt.gasUsed}`);
    return receipt;
  };

  // ---- handle client against the real gateway -----------------------------
  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const signer = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );
  log("connecting gateway");
  const hc = await createEthersHandleClient(signer as any);
  log("gateway ready");

  // ---- fund the confidential vault ---------------------------------------
  log("funding vault");
  await send("mint base", base.write.mint([me, 100n * ONE]));
  await send("mint quote", quote.write.mint([me, 1_000_000n * ONE]));
  await send("approve base", base.write.approve([hashswap.address, 100n * ONE]));
  await send("approve quote", quote.write.approve([hashswap.address, 1_000_000n * ONE]));
  await send("deposit base", hashswap.write.deposit([base.address, 100n * ONE]));
  await send("deposit quote", hashswap.write.deposit([quote.address, 1_000_000n * ONE]));

  // ---- three encrypted intents -------------------------------------------
  // Sell 6 + sell 4 vs buy 8 -> 8 crosses internally, 2 reaches the pool.
  const intents: Array<[bigint, boolean]> = [
    [6n * ONE, false],
    [4n * ONE, false],
    [8n * ONE, true],
  ];

  const gasPerIntent: bigint[] = [];
  for (const [amount, isBuy] of intents) {
    const t0 = Date.now();
    const amt = await hc.encryptInput(amount, "uint256", hashswap.address);
    const side = await hc.encryptInput(isBuy, "bool", hashswap.address);
    log("encryptInput x2", `${Date.now() - t0}ms`);

    const r = await send(
      `submitIntent ${isBuy ? "buy" : "sell"} ${amount / ONE}`,
      hashswap.write.submitIntent([
        amt.handle,
        amt.handleProof,
        side.handle,
        side.handleProof,
      ]),
    );
    gasPerIntent.push(r.gasUsed);
  }

  // ---- close --------------------------------------------------------------
  log("waiting batch window", "60s");
  await sleep(65_000);

  const batchId = await hashswap.read.currentBatchId();
  const closeReceipt = await send("closeBatch", hashswap.write.closeBatch());
  const closedAt = Date.now();

  const batch = await hashswap.read.getBatch([batchId]);
  if (Number(batch.status) !== 1) {
    throw new Error(`batch not Closed (status ${batch.status}) — did it roll over?`);
  }
  log("residual handle", batch.residualHandle);

  // ---- THE measurement: how long until the residual is decryptable? -------
  let residual: bigint | undefined;
  let residualProof: `0x${string}` | undefined;
  let attempts = 0;
  let delay = 1000;

  while (Date.now() - closedAt < TIMEOUT_MS) {
    attempts++;
    try {
      const res = await hc.publicDecrypt(batch.residualHandle);
      residual = BigInt(res.value as any);
      residualProof = res.decryptionProof as `0x${string}`;
      log("publicDecrypt OK", `after ${Date.now() - closedAt}ms, ${attempts} attempts`);
      break;
    } catch (e: any) {
      const kind =
        e instanceof NotYetComputedHandleError
          ? "NotYetComputed"
          : (e?.constructor?.name ?? "Error");
      log("publicDecrypt retry", `${kind} (${Date.now() - closedAt}ms)`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 15_000);
    }
  }

  if (residual === undefined || residualProof === undefined) {
    throw new Error(`residual never became decryptable within ${TIMEOUT_MS}ms`);
  }

  const side = await hc.publicDecrypt(batch.sellSideHandle);
  const isSell = Boolean(side.value);
  log("residual", `${residual} (${residual / ONE} base), isSell=${isSell}`);

  // ---- settle: proves the proof verifies on-chain (I7) --------------------
  const settleReceipt = await send(
    "settle",
    hashswap.write.settle([
      batchId,
      residual,
      residualProof,
      isSell,
      side.decryptionProof as `0x${string}`,
      0n,
    ]),
  );

  const settled = await hashswap.read.getBatch([batchId]);

  console.log("\n=============== RESULTS ===============");
  console.log(`residual settled : ${residual / ONE} base (of 18 gross volume)`);
  console.log(`clearing price   : ${settled.clearingPrice}`);
  console.log(`gas / submitIntent: ${gasPerIntent.join(", ")}`);
  console.log(`gas / closeBatch  : ${closeReceipt.gasUsed}`);
  console.log(`gas / settle      : ${settleReceipt.gasUsed}`);
  console.log(`handle latency    : see "publicDecrypt OK" above`);
  console.log("=======================================\n");
}

main().catch((e) => {
  console.error("\nPROBE FAILED:", e?.shortMessage ?? e?.message ?? e);
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
});
