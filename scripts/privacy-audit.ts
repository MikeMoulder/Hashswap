import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

/// Two wallets, one batch, and an attempt to read each other's positions.
///
///   npx hardhat run scripts/privacy-audit.ts --network sepolia
///
/// Everything else in this repo demonstrates privacy with a single key, which
/// proves nothing about isolation — of course you can read your own handles.
/// This runs the claim properly:
///
///   I5  no intent amount appears in calldata, logs, or storage
///   I6  wallet A cannot decrypt wallet B's balance, and vice versa
///
/// Wallet B is derived from the deployer key so the run is reproducible, and is
/// funded from it.

const ONE = 10n ** 18n;
const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const head = (s: string) => `\n\x1b[1m${s}\x1b[0m`;

async function main() {
  const dep = JSON.parse(readFileSync("deployments/sepolia.json", "utf8"));
  const rpc = (process.env.SEPOLIA_RPC_URL ?? "").trim();
  const provider = new ethers.JsonRpcProvider(rpc);

  const pkA = "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, "");
  const walletA = new ethers.Wallet(pkA, provider);

  // Deterministic second identity: keccak of A's key. Reproducible across runs,
  // and unmistakably a different account.
  const pkB = ethers.keccak256(pkA);
  const walletB = new ethers.Wallet(pkB, provider);

  console.log(`wallet A  ${walletA.address}`);
  console.log(`wallet B  ${walletB.address}`);

  const abi = [
    "function deposit(address token, uint256 amount)",
    "function submitIntent(bytes32,bytes,bytes32,bytes) returns (uint256)",
    "function balanceHandleOf(address token, address user) view returns (bytes32)",
  ];
  const erc20 = [
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
  ];

  const hsA = new ethers.Contract(dep.contracts.hashswap, abi, walletA);
  const hsB = new ethers.Contract(dep.contracts.hashswap, abi, walletB);
  const baseA = new ethers.Contract(dep.contracts.base, erc20, walletA);
  const baseB = new ethers.Contract(dep.contracts.base, erc20, walletB);

  // ---- fund B -----------------------------------------------------------
  const balB = await provider.getBalance(walletB.address);
  if (balB < ethers.parseEther("0.02")) {
    console.log(head("funding wallet B"));
    const tx = await walletA.sendTransaction({
      to: walletB.address,
      value: ethers.parseEther("0.03"),
    });
    await tx.wait();
    console.log(ok(`sent 0.03 ETH to B`));
  }

  const hcA = await createEthersHandleClient(walletA as any);
  const hcB = await createEthersHandleClient(walletB as any);

  // ---- both wallets take a position -------------------------------------
  console.log(head("both wallets deposit and submit"));

  const AMOUNT_A = 7n * ONE;
  const AMOUNT_B = 3n * ONE;

  for (const [tag, w, hs, base, hc, amount] of [
    ["A", walletA, hsA, baseA, hcA, AMOUNT_A],
    ["B", walletB, hsB, baseB, hcB, AMOUNT_B],
  ] as const) {
    await (await (base as any).mint(w.address, amount)).wait();
    await (await (base as any).approve(dep.contracts.hashswap, amount)).wait();
    await (await (hs as any).deposit(dep.contracts.base, amount)).wait();
    console.log(ok(`${tag} deposited ${amount / ONE} hBASE`));
  }

  // A submits an intent — this transaction is the one we audit.
  const amt = await hcA.encryptInput(5n * ONE, "uint256", dep.contracts.hashswap);
  const side = await hcA.encryptInput(false, "bool", dep.contracts.hashswap);
  const submitTx = await (hsA as any).submitIntent(
    amt.handle,
    amt.handleProof,
    side.handle,
    side.handleProof,
  );
  const receipt = await submitTx.wait();
  console.log(ok(`A submitted an encrypted intent  (tx ${receipt.hash.slice(0, 12)}…)`));

  // ---- I5: is the plaintext anywhere in that transaction? ----------------
  console.log(head("I5 — plaintext in calldata or logs?"));

  const full = await provider.getTransaction(receipt.hash);
  const calldata = full!.data.toLowerCase();
  const logs = receipt.logs.map((l: any) => (l.data + l.topics.join("")).toLowerCase()).join("");

  // 5e18 as a 32-byte word, and as a bare hex value.
  const needleWord = ethers.toBeHex(5n * ONE, 32).slice(2).toLowerCase();
  const needleRaw = (5n * ONE).toString(16).toLowerCase();

  const inCalldata = calldata.includes(needleWord) || calldata.includes(needleRaw);
  const inLogs = logs.includes(needleWord) || logs.includes(needleRaw);

  console.log(`  looking for ${needleRaw} (5 hBASE)`);
  console.log(inCalldata ? bad("FOUND in calldata") : ok("absent from calldata"));
  console.log(inLogs ? bad("FOUND in logs") : ok("absent from logs"));
  console.log(`  calldata is ${(calldata.length - 2) / 2} bytes: a selector, two handles, two proofs`);

  // ---- I6: can they read each other? ------------------------------------
  console.log(head("I6 — cross-wallet decryption"));

  const handleA: string = await (hsA as any).balanceHandleOf(dep.contracts.base, walletA.address);
  const handleB: string = await (hsA as any).balanceHandleOf(dep.contracts.base, walletB.address);
  console.log(`  A's balance handle  ${handleA.slice(0, 22)}…`);
  console.log(`  B's balance handle  ${handleB.slice(0, 22)}…`);
  console.log("  (both are public on-chain — the values behind them are not)");

  /// Retry before concluding "denied".
  ///
  /// A freshly written handle is not readable immediately — the Runner computes
  /// it off-chain after the transaction lands (~7s, measured). Without a retry
  /// the owner's own balance looks ACL-denied, which would be a false negative
  /// and exactly the wrong conclusion to draw. Only `NotYetComputedHandleError`
  /// is retried; a real authorisation failure is reported straight away.
  const attempt = async (hc: any, handle: string, tries = 6) => {
    let lastErr = "";
    for (let i = 0; i < tries; i++) {
      try {
        const r = await hc.decrypt(handle);
        return { allowed: true, value: BigInt(r.value), err: "" };
      } catch (e: any) {
        lastErr = e?.constructor?.name ?? e?.message ?? String(e);
        const pending = /NotYetComputed|not yet|pending|Unknown/i.test(
          `${lastErr} ${e?.message ?? ""}`,
        );
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    return { allowed: false, value: 0n, err: lastErr };
  };

  // The ACL itself is the invariant, and it lives on-chain. Asserting against it
  // is stronger than inferring from whether a decrypt call happened to succeed:
  // a failed decrypt could mean "not authorised" OR "gateway had a bad day", and
  // those must not be conflated. `viewACL` reads the authoritative state.
  const aclA = await hcA.viewACL(handleA as any);
  const aclB = await hcA.viewACL(handleB as any);

  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const A = walletA.address.toLowerCase();
  const B = walletB.address.toLowerCase();

  const aAdminsA = lower(aclA.admins).includes(A);
  const bAdminsA = lower(aclA.admins).includes(B);
  const bAdminsB = lower(aclB.admins).includes(B);
  const aAdminsB = lower(aclB.admins).includes(A);

  console.log(`  A's handle admins: ${aclA.admins.join(", ")}`);
  console.log(`  B's handle admins: ${aclB.admins.join(", ")}`);

  console.log(aAdminsA ? ok("A is admin on its own balance") : bad("A is NOT admin on its own balance"));
  console.log(bAdminsB ? ok("B is admin on its own balance") : bad("B is NOT admin on its own balance"));
  console.log(bAdminsA ? bad("B IS ADMIN ON A's BALANCE") : ok("B has no rights over A's balance"));
  console.log(aAdminsB ? bad("A IS ADMIN ON B's BALANCE") : ok("A has no rights over B's balance"));
  console.log(
    !aclA.isPublic && !aclB.isPublic ? ok("neither handle is publicly decryptable") : bad("a balance handle is public"),
  );
  console.log(
    aclA.viewers.length === 0 && aclB.viewers.length === 0
      ? ok("no third-party viewers granted")
      : bad(`viewers present: ${[...aclA.viewers, ...aclB.viewers].join(", ")}`),
  );

  // Live decrypt, reported separately. The gateway currently 401s on the data
  // access token even when the ACL clearly permits the read, so this is recorded
  // as information rather than folded into the verdict — see the note printed
  // below. Cross-wallet attempts still must NOT succeed.
  console.log(head("live decrypt through the gateway"));
  const aOwn = await attempt(hcA, handleA, 3);
  const aOnB = await attempt(hcA, handleB, 1);
  const bOnA = await attempt(hcB, handleA, 1);

  console.log(
    aOwn.allowed
      ? ok(`A decrypted its own balance: ${aOwn.value / ONE} hBASE`)
      : `  \x1b[33m!\x1b[0m A's own decrypt failed at the gateway (${aOwn.err}) — ACL above says it is authorised`,
  );
  console.log(aOnB.allowed ? bad(`A READ B's balance: ${aOnB.value}`) : ok("A cannot read B's balance"));
  console.log(bOnA.allowed ? bad(`B READ A's balance: ${bOnA.value}`) : ok("B cannot read A's balance"));

  // ---- verdict ----------------------------------------------------------
  const i5 = !inCalldata && !inLogs;
  const i6 =
    aAdminsA && bAdminsB && !bAdminsA && !aAdminsB && !aclA.isPublic && !aclB.isPublic && !aOnB.allowed && !bOnA.allowed;

  console.log(head(i5 && i6 ? "\x1b[32mPASS\x1b[0m — I5 and I6 hold on live Sepolia" : "\x1b[31mFAIL\x1b[0m"));
  console.log(`  I5 confidentiality  ${i5 ? "pass" : "FAIL"}`);
  console.log(`  I6 ACL isolation    ${i6 ? "pass" : "FAIL"}`);
  if (!aOwn.allowed) {
    console.log(
      "\n  Note: owner-side decryption is failing at the Handle Gateway with a 401\n" +
        "  on the data-access token, despite the on-chain ACL granting the right.\n" +
        "  That is a gateway/SDK issue, not a protocol one — but it does mean the\n" +
        "  UI's 'decrypt my balance' button is currently non-functional.",
    );
  }
  if (!(i5 && i6)) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\naudit failed:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
