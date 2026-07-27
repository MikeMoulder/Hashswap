import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

/// Submit a batch of encrypted intents and close it, leaving settlement to the
/// keeper. Splitting this from `probe-sepolia.ts` is what lets the two halves of
/// the two-transaction flow be exercised as genuinely separate processes.
///
///   npx hardhat run scripts/submit-batch.ts --network sepolia

const ONE = 10n ** 18n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(24)} ${d}`);

/// [amount in base units, isBuy]. Sells 6 + 4 against a buy of 8: 8 crosses
/// internally and only 2 ever reaches the pool.
const INTENTS: Array<[bigint, boolean]> = [
  [6n * ONE, false],
  [4n * ONE, false],
  [8n * ONE, true],
];

async function main() {
  const dep = JSON.parse(readFileSync("deployments/sepolia.json", "utf8"));
  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const hashswap = await viem.getContractAt("HashSwap", dep.contracts.hashswap);

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const signer = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );
  const hc = await createEthersHandleClient(signer as any);

  const batchId = await hashswap.read.currentBatchId();
  log("batch", batchId.toString());

  for (const [amount, isBuy] of INTENTS) {
    const amt = await hc.encryptInput(amount, "uint256", hashswap.address);
    const side = await hc.encryptInput(isBuy, "bool", hashswap.address);

    const hash = await hashswap.write.submitIntent([
      amt.handle,
      amt.handleProof,
      side.handle,
      side.handleProof,
    ]);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    log(`${isBuy ? "buy " : "sell"} ${amount / ONE}`, `gas ${r.gasUsed}`);
  }

  log("waiting window", "65s");
  await sleep(65_000);

  const hash = await hashswap.write.closeBatch();
  const r = await publicClient.waitForTransactionReceipt({ hash });
  log("closeBatch", `gas ${r.gasUsed}`);

  const b = await hashswap.read.getBatch([batchId]);
  if (Number(b.status) !== 1) throw new Error(`batch ${batchId} did not close (status ${b.status})`);

  log("closed", `residual handle ${b.residualHandle}`);
  log("handing off", "keeper should settle this");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
