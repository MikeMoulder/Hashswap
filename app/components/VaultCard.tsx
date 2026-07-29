"use client";

import { useCallback, useEffect, useState } from "react";
import { readHandle, type Session } from "@/lib/hashswap";
import { formatUnits, parseUnits, type Market, type Token } from "@/lib/markets";
import {
  finalize,
  forgetPending,
  loadPending,
  withdraw,
  type PendingRecord,
  type WithdrawPhase,
} from "@/lib/withdraw";
import type { VaultBalance } from "./TokenPanel";

/// The way out of the confidential vault.
///
/// The app could deposit but not withdraw, so anything put in stayed in. The
/// contract always had `requestWithdraw` / `finalizeWithdraw`; they were simply
/// never wired up here.
///
/// The two-transaction shape is shown rather than hidden. A request that never
/// gets finalised leaves the balance debited and no tokens released, so the user
/// needs to be able to see that state and act on it — which is also why any
/// interrupted request is picked back up on load.
export function VaultCard({
  session,
  market,
  onActivity,
}: {
  session: Session | null;
  market: Market;
  onActivity: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState<Record<string, VaultBalance>>({});
  const [picked, setPicked] = useState<Token>(market.base);
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<WithdrawPhase>({ kind: "idle" });
  const [pending, setPending] = useState<PendingRecord[]>([]);

  const chainKey = `${market.id}:${session?.address ?? "anon"}`;

  useEffect(() => setPicked(market.base), [market]);

  const load = useCallback(async () => {
    if (!session) return;
    // Sequential, for the same reason the swap card reads them one at a time:
    // the first decrypt of the hour opens a signature request, and two at once
    // means the wallet drops one.
    const next: Record<string, VaultBalance> = {};
    for (const t of [market.base, market.quote]) {
      const handle = await session.hashswap.balanceHandleOf(t.address, session.address);
      const r = await readHandle(session.handleClient, handle);
      next[t.address] =
        r.status === "ok"
          ? { kind: "ready", value: r.value }
          : r.status === "locked"
            ? { kind: "locked", reason: r.reason }
            : r.status === "denied"
              ? { kind: "denied", reason: r.reason }
              : { kind: "error", reason: r.reason };
      if (r.status === "locked") break;
    }
    setBalances(next);
  }, [session, market]);

  useEffect(() => {
    if (!session) {
      setBalances({});
      setPending([]);
      return;
    }
    if (open) load().catch(() => undefined);
    setPending(loadPending(chainKey));
  }, [session, open, load, chainKey]);

  if (!session) return null;

  const held = balances[picked.address];
  const heldValue = held?.kind === "ready" ? held.value : null;

  const parsed = (() => {
    try {
      return amount ? parseUnits(amount, picked.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();

  const busy =
    phase.kind === "requesting" || phase.kind === "proving" || phase.kind === "finalizing";

  async function run(fn: () => Promise<void>) {
    try {
      await fn();
      setAmount("");
      await load().catch(() => undefined);
      onActivity();
    } catch (e: any) {
      setPhase({ kind: "failed", reason: e?.shortMessage ?? e?.message ?? String(e) });
    } finally {
      setPending(loadPending(chainKey));
    }
  }

  return (
    <div className="glass px-5 py-4 mt-3" style={{ maxWidth: 440, width: "100%" }}>
      <button
        className="flex items-center justify-between w-full"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="eyebrow">Your vault</span>
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--faint)" }}>
          {pending.length > 0 && (
            <span className="tag tag-red" style={{ fontSize: 9 }}>
              {pending.length} unfinished
            </span>
          )}
          {open ? "Hide" : "Deposit and withdraw"}
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s ease" }}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="fade-up mt-4">
          {/* A request whose second transaction never landed. The balance is
              already debited, so this is the only thing standing between the
              user and their tokens. */}
          {pending.map((p) => (
            <div
              key={p.id}
              className="surface px-3 py-2.5 mb-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-[12px]">Withdrawal #{p.id} not finished</p>
                <p className="text-[11px] mono" style={{ color: "var(--faint)" }}>
                  Debited already. Finish it to release the tokens.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="btn btn-line"
                  disabled={busy}
                  onClick={() =>
                    run(() => finalize(session!, BigInt(p.id), chainKey, setPhase))
                  }
                >
                  Finish
                </button>
                <button
                  className="btn btn-quiet text-[11px]"
                  style={{ color: "var(--faint)" }}
                  title="Only removes the local reminder. The on-chain request stays where it is."
                  onClick={() => {
                    forgetPending(chainKey, BigInt(p.id));
                    setPending(loadPending(chainKey));
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}

          <div className="flex gap-2 mb-3">
            {[market.base, market.quote].map((t) => (
              <button
                key={t.address}
                className="btn btn-line flex-1"
                style={{
                  borderColor: t.address === picked.address ? "var(--red)" : undefined,
                  color: t.address === picked.address ? "var(--paper)" : "var(--muted)",
                }}
                disabled={busy}
                onClick={() => {
                  setPicked(t);
                  setAmount("");
                }}
              >
                {t.symbol}
              </button>
            ))}
          </div>

          <div className="field p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px]" style={{ color: "var(--faint)" }}>
                Held in vault
              </span>
              <span className="text-[12px] tnum" style={{ color: "var(--muted)" }}>
                {heldValue !== null ? (
                  <>
                    {formatUnits(heldValue, picked.decimals, 6)} {picked.symbol}
                    {heldValue > 0n && (
                      <button
                        className="btn btn-quiet ml-3"
                        onClick={() =>
                          setAmount(formatUnits(heldValue, picked.decimals, 8).replace(/,/g, ""))
                        }
                      >
                        MAX
                      </button>
                    )}
                  </>
                ) : held?.kind === "locked" ? (
                  <button className="btn btn-quiet" onClick={() => load().catch(() => undefined)}>
                    Sign to reveal
                  </button>
                ) : (
                  <span style={{ color: "var(--faint)" }}>Reading</span>
                )}
              </span>
            </div>

            <input
              className="amount"
              style={{ fontSize: 20 }}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
              }}
            />
          </div>

          <button
            className="btn btn-line w-full mt-3"
            disabled={busy || parsed === 0n}
            onClick={() =>
              run(() => withdraw(session!, picked.address, parsed, chainKey, setPhase))
            }
          >
            {phase.kind === "requesting"
              ? "Requesting"
              : phase.kind === "proving"
                ? `Waiting for the proof (${Math.round(phase.waited / 1000)}s)`
                : phase.kind === "finalizing"
                  ? "Releasing"
                  : `Withdraw ${picked.symbol}`}
          </button>

          <PhaseNote phase={phase} token={picked} />

          <div className="mt-4">
            <WithdrawCycle phase={phase} />
          </div>
        </div>
      )}
    </div>
  );
}

type CycleState = "todo" | "active" | "done" | "failed";

/// The withdrawal's three beats, live.
///
/// Replaces a paragraph that described the same thing. The shape says it better
/// than the prose did: two solid legs with a dashed one between them, because
/// the middle step is the only one nobody signs — it is the enclave computing,
/// and it is where the wait comes from.
function WithdrawCycle({ phase }: { phase: WithdrawPhase }) {
  const states: CycleState[] =
    phase.kind === "requesting"
      ? ["active", "todo", "todo"]
      : phase.kind === "proving"
        ? ["done", "active", "todo"]
        : phase.kind === "finalizing"
          ? ["done", "done", "active"]
          : phase.kind === "done"
            ? ["done", "done", "done"]
            : phase.kind === "rejected"
              ? // The proof came back false: the debit never happened, so nothing
                // was released and nothing was lost.
                ["done", "done", "failed"]
              : phase.kind === "failed"
                ? // An id means the request landed and it broke afterwards.
                  phase.id != null
                  ? ["done", "failed", "todo"]
                  : ["failed", "todo", "todo"]
                : ["todo", "todo", "todo"];

  const steps = [
    { label: "Debit", note: "Encrypted balance reduced", offchain: false },
    {
      label: "Prove",
      note:
        phase.kind === "proving"
          ? `Gateway signing, ${Math.round(phase.waited / 1000)}s`
          : "Gateway signs it, usually under 10s",
      offchain: true,
    },
    { label: "Release", note: "Tokens back in your wallet", offchain: false },
  ];

  return (
    <ol className="cycle">
      {steps.map((s, i) => (
        <li key={s.label} className="cycle-step" data-state={states[i]} data-offchain={s.offchain}>
          <span className="cycle-track">
            <span className="cycle-node">
              {states[i] === "done" && (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 12.5l5.5 5.5L20 6.5"
                    stroke="currentColor"
                    strokeWidth="3.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {states[i] === "failed" && (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
                  <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
                </svg>
              )}
              {states[i] === "active" && <span className="flow-spin" />}
            </span>
          </span>
          <span className="cycle-label">{s.label}</span>
          <span className="cycle-note">{s.note}</span>
        </li>
      ))}
    </ol>
  );
}

function PhaseNote({ phase, token }: { phase: WithdrawPhase; token: Token }) {
  if (phase.kind === "done") {
    return (
      <p className="fade-up text-[12px] mt-3" style={{ color: "var(--green)" }}>
        Sent {formatUnits(phase.amount, token.decimals, 6)} {token.symbol} back to your wallet.
      </p>
    );
  }
  if (phase.kind === "rejected") {
    return (
      <p className="fade-up text-[12px] mt-3" style={{ color: "var(--amber)" }}>
        The vault balance did not cover that. Nothing moved and nothing was lost,
        the contract kept your balance intact.
      </p>
    );
  }
  if (phase.kind === "failed") {
    return (
      <p className="text-[12px] mono mt-3" style={{ color: "var(--red)" }}>
        {phase.reason}
      </p>
    );
  }
  if (phase.kind === "proving") {
    return (
      <p className="text-[11px] mt-3" style={{ color: "var(--faint)" }}>
        Your balance is already debited. Leave this open until it finishes, or
        resume it from here later.
      </p>
    );
  }
  return null;
}
