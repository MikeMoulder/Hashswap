import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { deriveParticipant, ensureGas } from "./lib/participants.js";

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
///
/// Each filler is a **separate address**. The contract allows one intent per
/// address per batch (build.md F19), so fillers cannot share the operator key —
/// and a batch padded from one wallet would not have satisfied `MIN_BATCH_SIZE`
/// in spirit anyway, only in arithmetic.

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
  // Mock tokens are freely mintable, so each filler is funded directly rather
  // than transferred to — one transaction instead of two.
  const HS = [
    "function deposit(address,uint256)",
    "function submitIntent(bytes32,bytes,bytes32,bytes) returns (uint256)",
  ];
  const ERC = ["function approve(address,uint256) returns (bool)"];

  // Alternate sides so the batch has something to net against.
  for (let i = 0; i < missing; i++) {
    const isBuy = i % 2 === 0;
    const amount = (2n + BigInt(i)) * ONE;

    // Filler index starts at 2 — participant 1 is the operator, who may already
    // hold an intent in this batch.
    const filler = deriveParticipant(signer.address, provider, i + 2);
    await ensureGas(signer, filler, { log });

    // Buyers post quote at the reference plus the contract's buffer; sellers post
    // base. Mint generously — these are worthless test tokens.
    const collateral = isBuy ? quote : base;
    const need = isBuy ? amount * 4000n : amount;
    await send(`mint filler ${i + 1}`, collateral.write.mint([filler.address, need]));

    const token = new ethers.Contract(
      isBuy ? quote.address : base.address,
      ERC,
      filler,
    );
    const vault = new ethers.Contract(hashswap.address, HS, filler);

    await (await token.approve(hashswap.address, need)).wait();
    await (await vault.deposit(isBuy ? quote.address : base.address, need)).wait();

    // The handle proof is bound to (owner, app), so each filler needs its own
    // client — proofs minted by the operator would be rejected for the filler.
    const hc = await createEthersHandleClient(filler as any);
    const amt = await hc.encryptInput(amount, "uint256", hashswap.address);
    const side = await hc.encryptInput(isBuy, "bool", hashswap.address);

    const r = await (
      await vault.submitIntent(amt.handle, amt.handleProof, side.handle, side.handleProof)
    ).wait();
    log(`filler ${i + 1} ${isBuy ? "buy " : "sell"} ${amount / ONE}`, `gas ${r.gasUsed}`);
  }

  const after = await hashswap.read.getBatch([batchId]);
  log("done", `batch ${batchId} now has ${after.count} orders — it can clear`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
