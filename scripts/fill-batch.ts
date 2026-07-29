import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

/// Top the current batch up to MIN_BATCH_SIZE so it can actually clear.
///
///   npx hardhat run scripts/fill-batch.ts --network sepolia
///
/// Testing alone is otherwise impossible by design: `closeBatch` refuses to
/// settle a batch below the minimum and rolls the window instead, because a
/// batch of one would reveal its only member. That is correct behaviour and
/// should not be weakened for convenience — so instead of lowering the floor,
/// this adds counterparties.
///
/// The filler orders are deliberately opposing and roughly balanced, which also
/// makes the demo show netting rather than a batch that simply dumps everything
/// on the pool.

const ONE = 10n ** 18n;
const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(22)} ${d}`);

async function main() {
  const dep = JSON.parse(readFileSync("deployments/sepolia.json", "utf8"));
  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();

  const hashswap = await viem.getContractAt("HashSwap", dep.contracts.hashswap);
  const base = await viem.getContractAt("MockERC20", dep.contracts.base);
  const quote = await viem.getContractAt("MockERC20", dep.contracts.quote);
  const [wallet] = await viem.getWalletClients();
  const me = wallet.account.address;

  const send = async (label: string, p: Promise<`0x${string}`>) => {
    const r = await publicClient.waitForTransactionReceipt({ hash: await p });
    log(label, `gas ${r.gasUsed}`);
    return r;
  };

  const batchId = await hashswap.read.currentBatchId();
  const batch = await hashswap.read.getBatch([batchId]);
  const min = await hashswap.read.MIN_BATCH_SIZE();

  if (Number(batch.status) !== 0) {
    log("nothing to do", `batch ${batchId} is not open (status ${batch.status})`);
    return;
  }

  const missing = Math.max(0, Number(min) - Number(batch.count));
  log(`batch ${batchId}`, `${batch.count} orders, needs ${missing} more`);
  if (missing === 0) {
    log("ready", "batch can already clear");
    return;
  }

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const signer = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );
  const hc = await createEthersHandleClient(signer as any);

  // Keep the vault funded — the filler needs collateral like anyone else.
  const topUp = 200n * ONE;
  await send("mint base", base.write.mint([me, topUp]));
  await send("mint quote", quote.write.mint([me, topUp * 4000n]));
  await send("approve base", base.write.approve([hashswap.address, topUp]));
  await send("approve quote", quote.write.approve([hashswap.address, topUp * 4000n]));
  await send("deposit base", hashswap.write.deposit([base.address, topUp]));
  await send("deposit quote", hashswap.write.deposit([quote.address, topUp * 4000n]));

  // Alternate sides so the batch has something to net against.
  for (let i = 0; i < missing; i++) {
    const isBuy = i % 2 === 0;
    const amount = (2n + BigInt(i)) * ONE;

    const amt = await hc.encryptInput(amount, "uint256", hashswap.address);
    const side = await hc.encryptInput(isBuy, "bool", hashswap.address);

    await send(
      `filler ${isBuy ? "buy " : "sell"} ${amount / ONE}`,
      hashswap.write.submitIntent([amt.handle, amt.handleProof, side.handle, side.handleProof]),
    );
  }

  const after = await hashswap.read.getBatch([batchId]);
  log("done", `batch ${batchId} now has ${after.count} orders — it can clear`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
