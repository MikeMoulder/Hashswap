import { readFileSync, existsSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";

/// Wrap ETH into canonical Sepolia WETH9 (or unwrap it back).
///
///   AMOUNT=0.1 npx hardhat run scripts/wrap-eth.ts --network sepolia
///   AMOUNT=0.1 UNWRAP=1 npx hardhat run scripts/wrap-eth.ts --network sepolia
///   AMOUNT=0.1 KEY=MAKER npx hardhat run scripts/wrap-eth.ts --network sepolia
///
/// WETH is the base of every market in deployments/markets.json, so a wallet
/// with only ETH cannot place an order until it has wrapped some. This does the
/// one step; scripts/acquire-tokens.ts wraps *and* buys the quote tokens.

const WETH9 = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";

const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256)",
  "function balanceOf(address) view returns (uint256)",
];

/// Leave enough behind to pay for the wrap itself and a couple of follow-ups.
const GAS_RESERVE = ethers.parseEther("0.005");

function env(): Record<string, string> {
  if (!existsSync(".env")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function main() {
  const amount = ethers.parseEther((process.env.AMOUNT ?? "0.05").trim());
  const unwrap = /^(1|true|yes)$/i.test((process.env.UNWRAP ?? "").trim());
  const role = (process.env.KEY ?? "DEPLOYER").trim().toUpperCase();

  await network.connect();
  const e = env();

  const pk = (process.env.PRIVATE_KEY ?? e[`${role}_PRIVATE_KEY`] ?? "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(`no usable key — set PRIVATE_KEY, or ${role}_PRIVATE_KEY in .env`);
  }

  const provider = new ethers.JsonRpcProvider(
    (process.env.SEPOLIA_RPC_URL ?? e.SEPOLIA_RPC_URL ?? "").trim(),
    { chainId: 11155111, name: "sepolia" },
    { staticNetwork: true },
  );
  provider.pollingInterval = 5000;

  const me = new ethers.Wallet("0x" + pk.replace(/^0x/, ""), provider);
  const weth = new ethers.Contract(WETH9, WETH_ABI, me);

  const eth: bigint = await provider.getBalance(me.address);
  const wrapped: bigint = await weth.balanceOf(me.address);
  console.log(`\nwallet ${me.address}  (${role})`);
  console.log(`ETH    ${ethers.formatEther(eth)}`);
  console.log(`WETH   ${ethers.formatEther(wrapped)}\n`);

  if (unwrap) {
    if (wrapped < amount) throw new Error(`only ${ethers.formatEther(wrapped)} WETH to unwrap`);
    console.log(`unwrapping ${ethers.formatEther(amount)} WETH -> ETH`);
    const tx = await weth.withdraw(amount);
    console.log(`  ${tx.hash}`);
    await tx.wait();
  } else {
    if (eth < amount + GAS_RESERVE) {
      throw new Error(
        `need ${ethers.formatEther(amount + GAS_RESERVE)} ETH ` +
          `(${ethers.formatEther(amount)} + gas reserve), have ${ethers.formatEther(eth)}`,
      );
    }
    console.log(`wrapping ${ethers.formatEther(amount)} ETH -> WETH`);
    const tx = await weth.deposit({ value: amount });
    console.log(`  ${tx.hash}`);
    await tx.wait();
  }

  console.log(`\nETH    ${ethers.formatEther(await provider.getBalance(me.address))}`);
  console.log(`WETH   ${ethers.formatEther(await weth.balanceOf(me.address))}\n`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
