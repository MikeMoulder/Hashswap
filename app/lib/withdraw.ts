"use client";

import { ethers } from "ethers";
import type { Session } from "./hashswap";

/// Getting tokens back out of the confidential vault.
///
/// Three steps, not one, and the middle one is off-chain:
///
///   1. `requestWithdraw` debits the encrypted balance and publishes an
///      encrypted ok-flag. Solidity cannot `require` on a ciphertext, so the
///      contract cannot tell you here whether you could afford it.
///   2. Ask the gateway to decrypt that flag and sign the answer. A freshly
///      written handle is not readable straight away — measured at roughly 7s on
///      Sepolia (scripts/keeper.ts) — so this polls rather than asking once.
///   3. `finalizeWithdraw` verifies the signature on-chain and releases the
///      tokens. Permissionless: the proof authorises, not the caller, and funds
///      always go to the original requester.
///
/// Step 1 costs a transaction whether or not step 3 ever happens, so a request
/// left half-done is a real way to strand funds. The id is persisted the moment
/// it exists and resumed on the next load.

export type WithdrawPhase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "proving"; id: bigint; waited: number }
  | { kind: "finalizing"; id: bigint }
  | { kind: "done"; amount: bigint }
  | { kind: "rejected"; id: bigint }
  | { kind: "failed"; reason: string; id?: bigint };

export type PendingRecord = { id: string; token: string; amount: string };

const KEY = "hashswap:pending-withdrawals";

function storageKey(chainKey: string) {
  return `${KEY}:${chainKey}`;
}

export function loadPending(chainKey: string): PendingRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(chainKey));
    return raw ? (JSON.parse(raw) as PendingRecord[]) : [];
  } catch {
    return [];
  }
}

function savePending(chainKey: string, rows: PendingRecord[]) {
  try {
    window.localStorage.setItem(storageKey(chainKey), JSON.stringify(rows));
  } catch {
    /* private browsing; the on-chain record is still authoritative */
  }
}

function rememberPending(chainKey: string, rec: PendingRecord) {
  const rows = loadPending(chainKey).filter((r) => r.id !== rec.id);
  rows.push(rec);
  savePending(chainKey, rows);
}

export function forgetPending(chainKey: string, id: bigint) {
  savePending(
    chainKey,
    loadPending(chainKey).filter((r) => r.id !== id.toString()),
  );
}

/// Poll the gateway for a signed decryption of the ok-flag.
///
/// The first attempts are expected to fail while the Runner catches up, so this
/// backs off rather than treating an early miss as an error.
async function proveOk(
  session: Session,
  okHandle: string,
  onWait: (elapsedMs: number) => void,
  maxWaitMs = 120_000,
): Promise<{ ok: boolean; proof: string }> {
  const started = Date.now();
  let delay = 2500;
  let last = "";

  while (Date.now() - started < maxWaitMs) {
    try {
      // The contract's `bytes32` comes back as a plain string; the SDK types it
      // as a hex literal.
      const r = await session.handleClient.publicDecrypt(okHandle as `0x${string}`);
      return { ok: Boolean(r.value), proof: r.decryptionProof as string };
    } catch (e: any) {
      last = e?.message ?? String(e);
      onWait(Date.now() - started);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(Math.floor(delay * 1.4), 12_000);
    }
  }
  throw new Error(`The gateway did not produce a proof in time. Last error: ${last}`);
}

/// Finish a withdrawal whose request transaction already landed.
///
/// Split out from `withdraw` so a request that was interrupted — tab closed,
/// wallet reset, page reloaded between the two transactions — can be picked up
/// later instead of leaving the debit stranded with no matching release.
export async function finalize(
  session: Session,
  id: bigint,
  chainKey: string,
  report: (p: WithdrawPhase) => void,
): Promise<void> {
  const w = await session.hashswap.pendingWithdrawal(id);

  if (w.user === ethers.ZeroAddress) {
    forgetPending(chainKey, id);
    throw new Error(`Withdrawal ${id} is not on record.`);
  }
  if (w.finalized) {
    // Already released; the local note is just stale.
    forgetPending(chainKey, id);
    report({ kind: "done", amount: w.amount });
    return;
  }

  report({ kind: "proving", id, waited: 0 });
  const { ok, proof } = await proveOk(session, w.okHandle, (waited) =>
    report({ kind: "proving", id, waited }),
  );

  report({ kind: "finalizing", id });
  await (await session.hashswap.finalizeWithdraw(id, proof)).wait();
  forgetPending(chainKey, id);

  // `ok` false means the balance never covered the request. The contract kept
  // the balance intact via `Nox.select`, so nothing is lost, but no tokens moved
  // either and saying "done" would be a lie.
  report(ok ? { kind: "done", amount: w.amount } : { kind: "rejected", id });
}

/// Full withdrawal, request through release.
export async function withdraw(
  session: Session,
  token: `0x${string}`,
  amount: bigint,
  chainKey: string,
  report: (p: WithdrawPhase) => void,
): Promise<void> {
  report({ kind: "requesting" });

  const tx = await session.hashswap.requestWithdraw(token, amount);
  const receipt = await tx.wait();

  // `requestWithdraw` returns the id, but a transaction's return value is not
  // available to the caller — the event is the only way to learn it.
  const iface = session.hashswap.interface;
  let id: bigint | null = null;
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WithdrawalRequested") {
        id = parsed.args.id as bigint;
        break;
      }
    } catch {
      /* a log from another contract in the same transaction */
    }
  }

  if (id === null) {
    throw new Error("The withdrawal request landed but its id could not be read from the receipt.");
  }

  rememberPending(chainKey, { id: id.toString(), token, amount: amount.toString() });
  await finalize(session, id, chainKey, report);
}
