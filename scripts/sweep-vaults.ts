import { ethers } from "ethers";
import "dotenv/config";

/// Recover confidential balances left in superseded HashSwap deployments.
///
///   npx hardhat run scripts/sweep-vaults.ts --network sepolia
///   DRY=1 npx hardhat run scripts/sweep-vaults.ts --network sepolia   # report only
///
/// `baseToken` / `quoteToken` / `poolFee` are immutable, so a new version means a
/// new address, and whatever sat in the old vault stays there. Nothing is lost —
/// the old contracts still expose the full two-phase withdrawal — but it is
/// invisible from the app, which only ever reads the current registry.
///
/// This walks every retired deployment, decrypts the caller's own balance for
/// each of its tokens, and withdraws anything non-zero.
///
/// ## Why withdrawal is three steps
///
/// Solvency cannot be checked synchronously against an encrypted balance:
/// `requestWithdraw` debits and publishes an encrypted ok-flag, the gateway signs
/// a decryption of it (~7s, so this polls), and `finalizeWithdraw` verifies that
/// signature on-chain before releasing. Step one costs a transaction whether or
/// not step three ever runs, so a request abandoned in between strands the funds
/// it just debited — which is exactly the state this script exists to clear.

const RETIRED = [
  {
    label: "WETH-LINK (Jul 29)",
    hashswap: "0x5b4ec99d6db1b3368b0d99f055fd3056128ae1bf",
    tokens: [
      { symbol: "WETH", address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", decimals: 18 },
      { symbol: "LINK", address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", decimals: 18 },
    ],
  },
  {
    label: "WETH-DAI (Jul 29)",
    hashswap: "0x908a1df1e6fb011b12a2aac7d47bb0100e8189a0",
    tokens: [
      { symbol: "WETH", address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", decimals: 18 },
      { symbol: "DAI", address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18 },
    ],
  },
  {
    label: "LINK-USDC (Jul 29)",
    hashswap: "0x38cc21d63084a59a3571116e8f097f41617cde67",
    tokens: [
      { symbol: "LINK", address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", decimals: 18 },
      { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
    ],
  },
  {
    label: "single-market (Jul 27, mock tokens)",
    hashswap: "0xb27b0a0f47e5ca1f1daec32bcfbfc7310fa3d31f",
    tokens: [
      { symbol: "mBASE", address: "0x22f6abe62bcd5f9c31dabba4b580d2eb6b07fcfe", decimals: 18 },
      { symbol: "mQUOTE", address: "0x64fbde826c6f086c4f52733e01251a37bf9bd021", decimals: 18 },
    ],
  },
] as const;

const HS = [
  "function balanceHandleOf(address token, address user) view returns (bytes32)",
  "function requestWithdraw(address token, uint256 amount) returns (uint256)",
  "function finalizeWithdraw(uint256 id, bytes proof)",
  "function pendingWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 amount, bytes32 okHandle, bool finalized))",
  "event WithdrawalRequested(uint256 indexed id, address indexed user, address indexed token, uint256 amount, bytes32 okHandle)",
];

const ERC = ["function balanceOf(address) view returns (uint256)"];

const ZERO_HANDLE = /^0x0+$/;
const DRY = process.env.DRY === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d = "") => console.log(`  ${m.padEnd(34)} ${d}`);

/// Sepolia's public endpoints rate-limit hard and drop responses under load.
async function rpc<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
      if (!/Too Many Requests|missing response|BAD_DATA|timeout|network|failed to detect/i.test(msg)) throw e;
      await sleep(2500 * (i + 1));
    }
  }
  throw last;
}

/// Poll until the Runner has computed the ok-flag, then take the gateway's
/// signature over it. Early misses are expected, not errors.
async function proveOk(hc: any, handle: string): Promise<{ ok: boolean; proof: string }> {
  const started = Date.now();
  let delay = 2500;
  while (Date.now() - started < 120_000) {
    try {
      const r = await hc.publicDecrypt(handle);
      return { ok: Boolean(r.value), proof: r.decryptionProof as string };
    } catch {
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.4), 12_000);
    }
  }
  throw new Error("gateway did not produce a proof within 120s");
}

async function main() {
  const { createEthersHandleClient } = await import("@iexec-nox/handle");

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const me = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );
  const hc = await createEthersHandleClient(me as any);

  console.log(`\nsweeping into ${me.address}${DRY ? "   [DRY RUN]" : ""}`);

  const recovered: Record<string, bigint> = {};
  let failures = 0;

  for (const dep of RETIRED) {
    console.log(`\n${dep.label}  ${dep.hashswap}`);
    const hs = new ethers.Contract(dep.hashswap, HS, me);

    for (const t of dep.tokens) {
      let balance: bigint;
      try {
        const handle: string = await rpc("handle", () => hs.balanceHandleOf(t.address, me.address));
        if (!handle || ZERO_HANDLE.test(handle)) {
          log(`${t.symbol}`, "never held a balance");
          continue;
        }
        // Our own balance, so this is an authorised `decrypt`, not a public one.
        const r = await hc.decrypt(handle as `0x${string}`);
        balance = BigInt(r.value as any);
      } catch (e: any) {
        log(`${t.symbol} read failed`, (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 60));
        failures++;
        continue;
      }

      if (balance === 0n) {
        log(`${t.symbol}`, "empty");
        continue;
      }

      const human = ethers.formatUnits(balance, t.decimals);
      log(`${t.symbol} vault balance`, human);

      // The contract can only pay out what it actually holds; a partial sweep
      // beats a request that debits and then cannot be released.
      const held: bigint = await rpc("held", () =>
        new ethers.Contract(t.address, ERC, provider).balanceOf(dep.hashswap),
      );
      const amount = balance < held ? balance : held;
      if (amount < balance) {
        log(`  capped to contract holdings`, ethers.formatUnits(amount, t.decimals));
      }
      if (amount === 0n) {
        log(`  nothing to take`, "contract holds none of this token");
        continue;
      }
      if (DRY) {
        recovered[t.symbol] = (recovered[t.symbol] ?? 0n) + amount;
        continue;
      }

      try {
        const receipt = await (await hs.requestWithdraw(t.address, amount)).wait();
        let id: bigint | null = null;
        for (const lg of receipt.logs ?? []) {
          try {
            const p = hs.interface.parseLog({ topics: [...lg.topics], data: lg.data });
            if (p?.name === "WithdrawalRequested") { id = p.args.id as bigint; break; }
          } catch { /* a log from another contract */ }
        }
        if (id === null) throw new Error("no WithdrawalRequested event in receipt");

        const w = await rpc("pending", () => hs.pendingWithdrawal(id!));
        const { ok, proof } = await proveOk(hc, w.okHandle);
        await (await hs.finalizeWithdraw(id, proof)).wait();

        if (ok) {
          log(`  withdrawn`, `${ethers.formatUnits(amount, t.decimals)} ${t.symbol}`);
          recovered[t.symbol] = (recovered[t.symbol] ?? 0n) + amount;
        } else {
          // The debit never happened — `Nox.select` kept the balance — so the
          // funds are still there and this is safe to retry.
          log(`  refused`, "balance did not cover the request; nothing moved");
          failures++;
        }
      } catch (e: any) {
        log(`  FAILED`, (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 70));
        failures++;
      }
    }
  }

  console.log(`\n${DRY ? "would recover" : "recovered"}:`);
  const rows = Object.entries(recovered);
  if (!rows.length) console.log("  nothing");
  for (const [sym, amt] of rows) {
    const d = RETIRED.flatMap((r) => r.tokens).find((t) => t.symbol === sym)!.decimals;
    console.log(`  ${sym.padEnd(7)} ${ethers.formatUnits(amt, d)}`);
  }
  if (failures) console.log(`\n${failures} step(s) failed — safe to re-run; nothing is lost on a failed sweep.`);
  console.log();
}

main().catch((e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
