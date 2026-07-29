import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

/// Submit a single sealed order and stop.
///
///   MARKET=WETH-LINK npx hardhat run scripts/submit-one.ts --network sepolia
///
/// Deliberately leaves the batch under-filled. That is the situation the maker
/// of last resort exists for, so this is how you watch it work: submit one
/// order, then let `maker.ts` and `keeper.ts` carry it to settlement.

const log = (m: string, d = "") =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${m.padEnd(24)} ${d}`);

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  const id = process.env.MARKET ?? "WETH-LINK";
  const m = registry.markets.find((x: any) => x.id === id);
  if (!m) throw new Error(`unknown market ${id}`);

  await network.connect();
  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const signer = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );

  const hs = new ethers.Contract(
    m.hashswap,
    [
      "function deposit(address,uint256)",
      "function submitIntent(bytes32,bytes,bytes32,bytes) returns (uint256)",
      "function currentBatchId() view returns (uint256)",
      "function getBatch(uint256) view returns (tuple(uint64,uint64,uint32,uint8,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bool))",
    ],
    signer,
  );
  const base = new ethers.Contract(
    m.base.address,
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    signer,
  );

  const size = ethers.parseUnits(process.env.SIZE ?? "0.003", m.base.decimals);
  const hc = await createEthersHandleClient(signer as any);

  log("market", `${m.base.symbol}/${m.quote.symbol}`);

  const held: bigint = await base.balanceOf(signer.address);
  if (held >= size) {
    await (await base.approve(m.hashswap, size)).wait();
    await (await hs.deposit(m.base.address, size)).wait();
    log("deposited", `${ethers.formatUnits(size, m.base.decimals)} ${m.base.symbol}`);
  }

  const a = await hc.encryptInput(size, "uint256", m.hashswap);
  const s = await hc.encryptInput(false, "bool", m.hashswap);
  const r = await (await hs.submitIntent(a.handle, a.handleProof, s.handle, s.handleProof)).wait();

  const batchId = await hs.currentBatchId();
  const b = await hs.getBatch(batchId);
  log("sealed order sent", `gas ${r.gasUsed}`);
  log(`batch ${batchId}`, `${b[2]} order(s) — under-filled on purpose`);
  log("now run", "scripts/maker.ts + scripts/keeper.ts");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
