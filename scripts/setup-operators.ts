import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";

/// Split the three roles onto three keys.
///
///   npx hardhat run scripts/setup-operators.ts --network sepolia
///
/// Right now one key deploys, keeps, and makes markets. That is convenient and
/// wrong: the roles have completely different risk profiles.
///
///   DEPLOYER  holds `owner`, can install a maker and set its fee.
///             Highest value, should be cold and rarely touched.
///   KEEPER    needs gas and uptime, holds no capital, cannot steal
///             (the residual it submits is signature-verified on-chain).
///             Safe to run hot on a VPS.
///   MAKER     holds trading capital and takes market risk. Hot by necessity,
///             but compromising it loses only its inventory — it has no admin
///             rights over the protocol.
///
/// Generated keys are appended to `.env` and never printed, so they do not end
/// up in a terminal scrollback or a screen recording.

const HS_ABI = [
  "function setMaker(address,uint16)",
  "function maker() view returns (address)",
  "function owner() view returns (address)",
];
const ERC20 = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const KEEPER_GAS = ethers.parseEther("0.05");
const MAKER_GAS = ethers.parseEther("0.05");
const MAKER_FEE_BPS = 25;

/// Share of the deployer's tokens to hand the maker as trading inventory.
const MAKER_INVENTORY_PCT = 40n;

/// Retry through transient RPC rate limiting. Every call here is a one-off
/// setup step, so waiting is always better than failing halfway and leaving
/// keys funded but unregistered.
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

function readEnv(): Record<string, string> {
  if (!existsSync(".env")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  await network.connect();

  const env = readEnv();
  // `staticNetwork` skips the chainId probe ethers otherwise makes on startup —
  // when the RPC is rate limited that probe fails during construction, before
  // any retry logic can help, and reports as "failed to detect network".
  const provider = new ethers.JsonRpcProvider(
    (env.SEPOLIA_RPC_URL ?? "").trim(),
    { chainId: 11155111, name: "sepolia" },
    { staticNetwork: true },
  );
  // ethers polls receipts aggressively; on a shared key that trips
  // "Too Many Requests" and surfaces as a confusing BAD_DATA error mid-script.
  provider.pollingInterval = 5000;
  const deployer = new ethers.Wallet(
    "0x" + (env.DEPLOYER_PRIVATE_KEY ?? "").replace(/^0x/, ""),
    provider,
  );

  console.log(`\ndeployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH\n`);

  // ---- generate the two operational keys, once ---------------------------
  const created: string[] = [];

  const ensure = (name: string): ethers.Wallet => {
    const existing = env[name];
    if (existing) {
      const w = new ethers.Wallet("0x" + existing.replace(/^0x/, ""), provider);
      console.log(`${name.padEnd(22)} exists  ${w.address}`);
      return w;
    }
    const w = ethers.Wallet.createRandom().connect(provider) as unknown as ethers.Wallet;
    created.push(`${name}=${w.privateKey}`);
    console.log(`${name.padEnd(22)} created ${w.address}`);
    return w;
  };

  const keeper = ensure("KEEPER_PRIVATE_KEY");
  const maker = ensure("MAKER_PRIVATE_KEY");

  if (created.length) {
    appendFileSync(".env", `\n# generated ${new Date().toISOString()}\n${created.join("\n")}\n`);
    console.log(`\nwrote ${created.length} key(s) to .env (gitignored, never printed)`);
  }

  // ---- fund gas ----------------------------------------------------------
  console.log("\nfunding gas");
  for (const [label, w, want] of [
    ["keeper", keeper, KEEPER_GAS],
    ["maker", maker, MAKER_GAS],
  ] as const) {
    const have = await rpc(`${label} balance`, () => provider.getBalance(w.address));
    if (have >= want) {
      console.log(`  ${label.padEnd(8)} already has ${ethers.formatEther(have)} ETH`);
      continue;
    }
    await rpc(`${label} funding`, async () => {
      const tx = await deployer.sendTransaction({ to: w.address, value: want - have });
      return tx.wait();
    });
    console.log(`  ${label.padEnd(8)} sent ${ethers.formatEther(want - have)} ETH`);
  }

  // ---- hand the maker its inventory --------------------------------------
  console.log("\nfunding maker inventory");
  const seen = new Set<string>();
  for (const m of registry.markets) {
    for (const t of [m.base, m.quote]) {
      if (seen.has(t.address)) continue;
      seen.add(t.address);

      const token = new ethers.Contract(t.address, ERC20, deployer);
      const held: bigint = await rpc(`${t.symbol} balance`, () => token.balanceOf(deployer.address));
      const send = (held * MAKER_INVENTORY_PCT) / 100n;
      if (send === 0n) {
        console.log(`  ${t.symbol.padEnd(6)} deployer holds none, skipped`);
        continue;
      }
      await rpc(`${t.symbol} transfer`, async () => (await token.transfer(maker.address, send)).wait());
      console.log(`  ${t.symbol.padEnd(6)} sent ${ethers.formatUnits(send, t.decimals)}`);
    }
  }

  // ---- register the maker on every market --------------------------------
  console.log("\nregistering maker");
  for (const m of registry.markets) {
    const hs = new ethers.Contract(m.hashswap, HS_ABI, deployer);
    const owner = await rpc(`${m.id} owner`, () => hs.owner());
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`  ${m.id.padEnd(11)} SKIPPED — owner is ${owner}`);
      continue;
    }
    await rpc(`${m.id} setMaker`, async () => (await hs.setMaker(maker.address, MAKER_FEE_BPS)).wait());
    console.log(`  ${m.id.padEnd(11)} maker set, ${MAKER_FEE_BPS} bps`);
  }

  console.log(`
Roles are now separated:
  deployer  ${deployer.address}   admin — keep cold
  keeper    ${keeper.address}   gas only, no capital, cannot steal
  maker     ${maker.address}   trading inventory, no admin rights
`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
