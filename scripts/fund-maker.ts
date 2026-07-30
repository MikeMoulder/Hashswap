import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import "dotenv/config";
import { deriveParticipant } from "./lib/participants.js";

/// Top the maker up so it can keep rescuing batches.
///
///   npx hardhat run scripts/fund-maker.ts --network sepolia
///   DRY=1 npx hardhat run scripts/fund-maker.ts --network sepolia   # report only
///
/// ## Why this is a separate script, run from your machine
///
/// The obvious design is for the maker to refill itself. It cannot: refilling
/// means spending from the deployer, and the deployer key is the contract
/// `owner`. Putting it on the always-on host that runs the maker would hand an
/// internet-facing box the ability to install a maker, set fees, and move the
/// whole inventory — to save a command you run occasionally.
///
/// So the split is deliberate. The maker redistributes to its own lanes
/// automatically, on its own key, unattended. Only the top-up of the maker
/// itself needs your deployer key, and that happens here, locally, when you
/// choose. Nothing can auto-fund from an empty wallet anyway.
///
/// Run it before a demo, and again if `maker.ts` starts logging `running low`.

const GAS_TARGET = ethers.parseEther("0.25");
const GAS_FLOOR = ethers.parseEther("0.10");

/// Clips of inventory to hold per market. `maker.ts` seeds each lane with 25 and
/// the lanes keep their balance between batches, so this is a comfortable buffer
/// rather than a per-batch cost.
const CLIPS = 120n;

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const DRY = process.env.DRY === "1";
const log = (m: string, d = "") => console.log(`  ${m.padEnd(32)} ${d}`);

async function rpc<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
      if (!/Too Many Requests|missing response|BAD_DATA|timeout|network|failed to detect/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw last;
}

async function main() {
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());

  const deployerKey = (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
  const makerKey = (process.env.MAKER_PRIVATE_KEY ?? "").trim();
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is not set (run this locally, not on the host).");
  if (!makerKey) throw new Error("MAKER_PRIVATE_KEY is not set — nothing to fund.");

  const deployer = new ethers.Wallet("0x" + deployerKey.replace(/^0x/, ""), provider);
  const maker = new ethers.Wallet("0x" + makerKey.replace(/^0x/, ""), provider);

  console.log(`\nfunding maker ${maker.address}${DRY ? "   [DRY RUN]" : ""}`);
  console.log(`from deployer ${deployer.address}\n`);

  // ---- gas for the maker and each of its lanes ----------------------------
  // Lane indices must match maker.ts: lane 0 is the maker itself, lanes 1..2 are
  // derived from it.
  const MAX_LANES = 3;
  const wallets = [
    { name: "maker", addr: maker.address },
    ...Array.from({ length: MAX_LANES - 1 }, (_, i) => ({
      name: `lane ${i + 1}`,
      addr: deriveParticipant(maker.address, provider, i + 2).address,
    })),
  ];

  const deployerEth = await rpc(() => provider.getBalance(deployer.address));
  console.log(`deployer holds ${ethers.formatEther(deployerEth)} ETH\n`);

  for (const w of wallets) {
    const bal = await rpc(() => provider.getBalance(w.addr));
    if (bal >= GAS_FLOOR) {
      log(`${w.name} gas`, `${ethers.formatEther(bal).slice(0, 8)} ETH — ok`);
      continue;
    }
    const send = GAS_TARGET - bal;
    log(`${w.name} gas`, `${ethers.formatEther(bal).slice(0, 8)} ETH — topping up ${ethers.formatEther(send).slice(0, 8)}`);
    if (DRY) continue;
    if (deployerEth < send) {
      log(`  SKIPPED`, "deployer does not hold enough ETH");
      continue;
    }
    await (await deployer.sendTransaction({ to: w.addr, value: send })).wait();
  }

  // ---- inventory, per market ---------------------------------------------
  // Only the maker itself is funded with tokens here; `maker.ts` pushes them out
  // to whichever lane needs them, on its own key.
  console.log();
  for (const m of registry.markets) {
    const clip = 10n ** BigInt(m.base.decimals - 3);
    const needBase = clip * CLIPS;
    const needQuote = (clip * BigInt(m.refPrice) * 110n * CLIPS) / (10n ** 18n * 100n);

    for (const [label, token, need, decimals] of [
      ["base", m.base, needBase, m.base.decimals],
      ["quote", m.quote, needQuote, m.quote.decimals],
    ] as const) {
      const c = new ethers.Contract(token.address, ERC20, deployer);
      const held: bigint = await rpc(() => c.balanceOf(maker.address));
      if (held >= need) {
        log(`${m.id} ${token.symbol}`, `${ethers.formatUnits(held, decimals).slice(0, 10)} — ok`);
        continue;
      }

      const short = need - held;
      const deployerHas: bigint = await rpc(() => c.balanceOf(deployer.address));
      const send = deployerHas < short ? deployerHas : short;

      if (send === 0n) {
        log(`${m.id} ${token.symbol}`, `SHORT ${ethers.formatUnits(short, decimals).slice(0, 10)} — deployer has none`);
        continue;
      }
      log(
        `${m.id} ${token.symbol}`,
        `${ethers.formatUnits(held, decimals).slice(0, 10)} — sending ${ethers.formatUnits(send, decimals).slice(0, 10)}` +
          (send < short ? "  (partial — deployer short)" : ""),
      );
      if (!DRY) await (await c.transfer(maker.address, send)).wait();
    }
  }

  console.log(
    DRY
      ? "\ndry run — nothing sent. Drop DRY=1 to apply.\n"
      : "\ndone. Restart maker.ts if it was already reporting low balances.\n",
  );
}

main().catch((e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
