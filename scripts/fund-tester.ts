import { readFileSync, existsSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";

/// Send a tester everything they need to use the app.
///
///   TO=0xabc… npx hardhat run scripts/fund-tester.ts --network sepolia
///
/// Gas plus a slice of each market's tokens. The frontend cannot mint — these
/// are real Sepolia assets — so a fresh wallet is useless until it is funded.

const ERC20 = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const GAS = ethers.parseEther("0.05");

/// Share of the deployer's remaining balance to send, per token. Most inventory
/// is already sitting in vaults or with the maker, so this is a slice of what is
/// actually spendable rather than a fixed amount that might not be there.
const SHARE_PCT = 45n;

async function rpc<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
      if (!/Too Many Requests|missing response|BAD_DATA|timeout|network/i.test(msg)) throw e;
      const wait = 3000 * (i + 1);
      console.log(`  ${label}: rate limited, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

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
  const to = (process.env.TO ?? "").trim();
  if (!ethers.isAddress(to)) throw new Error(`set TO to a valid address (got "${to}")`);

  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  await network.connect();

  const e = env();
  const provider = new ethers.JsonRpcProvider(
    (e.SEPOLIA_RPC_URL ?? "").trim(),
    { chainId: 11155111, name: "sepolia" },
    { staticNetwork: true },
  );
  provider.pollingInterval = 5000;

  const from = new ethers.Wallet("0x" + (e.DEPLOYER_PRIVATE_KEY ?? "").replace(/^0x/, ""), provider);

  console.log(`\nfrom ${from.address}`);
  console.log(`to   ${to}\n`);

  // ---- gas ---------------------------------------------------------------
  const has = await rpc("recipient balance", () => provider.getBalance(to));
  if (has >= GAS) {
    console.log(`ETH    already has ${ethers.formatEther(has)}`);
  } else {
    await rpc("gas", async () => (await from.sendTransaction({ to, value: GAS - has })).wait());
    console.log(`ETH    sent ${ethers.formatEther(GAS - has)}`);
  }

  // ---- tokens ------------------------------------------------------------
  const seen = new Set<string>();
  for (const m of registry.markets) {
    for (const t of [m.base, m.quote]) {
      if (seen.has(t.address)) continue;
      seen.add(t.address);

      const token = new ethers.Contract(t.address, ERC20, from);
      const held: bigint = await rpc(`${t.symbol} balance`, () => token.balanceOf(from.address));
      const send = (held * SHARE_PCT) / 100n;

      if (send === 0n) {
        console.log(`${t.symbol.padEnd(6)} none available to send`);
        continue;
      }
      await rpc(`${t.symbol} transfer`, async () => (await token.transfer(to, send)).wait());
      console.log(`${t.symbol.padEnd(6)} sent ${ethers.formatUnits(send, t.decimals)}`);
    }
  }

  console.log(`
Ready. In the app:
  1. connect this wallet on Sepolia
  2. pick a market (WETH/LINK has the sanest price)
  3. enter an amount, deposit, then place a private order

A lone order will not settle — a batch needs three. Run scripts/maker.ts to
have the maker fill it, or scripts/fill-batch.ts to top it up manually.
`);
}

main().catch((err) => {
  console.error("FAILED:", err?.shortMessage ?? err?.message ?? err);
  process.exitCode = 1;
});
