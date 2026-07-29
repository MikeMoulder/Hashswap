"use client";

import { useCallback, useEffect, useState } from "react";
import { readHandle, short, type Session } from "@/lib/hashswap";
import { formatUnits } from "@/lib/markets";

/// Privacy you can check rather than take on trust.
///
/// Read your own balance, then try to read someone else's and watch the gateway
/// refuse. The handle is public and sits in plain sight on-chain; the number
/// behind it belongs to its owner alone.
///
/// The demo only lands if the address being tried actually holds something. An
/// address that has never deposited has a balance handle of the zero word, and
/// zero is answered locally without ever asking the gateway — so trying a random
/// address returned a confident `0.0`, which reads as *"I just read a stranger's
/// balance"*. The exact opposite of the point. Hence two things below: an empty
/// handle is now labelled as empty rather than as a reading, and real
/// participants are offered from recent batches so there is something to be
/// refused.

type State = "ok" | "refused" | "empty";
type Row = { label: string; handle: string; state: State; value: bigint | null; decimals: number };

const ZERO_HANDLE = /^0x0+$/;

export function PrivacyProof({ session }: { session: Session | null }) {
  const [mine, setMine] = useState<Row[] | null>(null);
  const [theirs, setTheirs] = useState<Row[] | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<"mine" | "theirs" | null>(null);
  const [traders, setTraders] = useState<string[]>([]);

  /// Real addresses with real handles, pulled from recent batches.
  ///
  /// Without these the only way to see a refusal is to already know someone
  /// else's funded address, which nobody evaluating this does.
  const findTraders = useCallback(async () => {
    if (!session) return;
    try {
      const current: bigint = await session.hashswap.currentBatchId();
      const found = new Set<string>();

      for (let id = current; id > 0n && id > current - 5n && found.size < 4; id--) {
        const n = Number(await session.hashswap.intentCount(id));
        for (let i = 0; i < n && found.size < 4; i++) {
          const it = await session.hashswap.getIntent(id, i);
          if (it.user.toLowerCase() !== session.address.toLowerCase()) found.add(it.user);
        }
      }
      setTraders([...found]);
    } catch {
      /* the picker is an aid, not a requirement */
    }
  }, [session]);

  useEffect(() => {
    if (!session) {
      setTraders([]);
      setMine(null);
      setTheirs(null);
      return;
    }
    findTraders();
  }, [session, findTraders]);

  async function read(who: string): Promise<Row[]> {
    const out: Row[] = [];
    for (const t of [session!.market.base, session!.market.quote]) {
      const handle: string = await session!.hashswap.balanceHandleOf(t.address, who);

      // Checked here rather than trusting the decrypt result, because a zero
      // handle never reaches the gateway — it is answered as zero locally, and
      // presenting that as a successful read of someone else's balance is the
      // one genuinely misleading thing this panel could do.
      if (!handle || ZERO_HANDLE.test(handle)) {
        out.push({ label: t.symbol, handle, state: "empty", value: null, decimals: t.decimals });
        continue;
      }

      const res = await readHandle(session!.handleClient, handle);
      out.push({
        label: t.symbol,
        handle,
        state: res.status === "ok" ? "ok" : "refused",
        value: res.status === "ok" ? res.value : null,
        decimals: t.decimals,
      });
    }
    return out;
  }

  const allEmpty = theirs?.every((r) => r.state === "empty");
  const anyRefused = theirs?.some((r) => r.state === "refused");

  return (
    <div className="glass p-6">
      <span className="eyebrow">Verify</span>
      <h3 className="display mt-2" style={{ fontSize: 26 }}>
        Don&apos;t take our word for it
      </h3>
      <p className="text-[14px] mt-2.5 leading-relaxed" style={{ color: "var(--muted)" }}>
        Every balance is stored on-chain as a reference, not a number. Anyone can
        see the reference. Read yours below, then try to read someone else&apos;s.
      </p>

      <button
        className="btn btn-line w-full mt-5"
        disabled={!session || busy !== null}
        onClick={async () => {
          setBusy("mine");
          try {
            setMine(await read(session!.address));
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "mine" ? "Reading…" : session ? "Read my balance" : "Connect a wallet first"}
      </button>
      {mine && <Result rows={mine} />}

      <hr className="rule my-6" />

      <p className="text-[13px] font-semibold">Someone else&apos;s</p>

      {traders.length > 0 && (
        <>
          <p className="text-[12px] mt-1.5" style={{ color: "var(--faint)" }}>
            Real addresses from recent batches. They hold balances, so there is
            something here to withhold.
          </p>
          <div className="flex flex-wrap gap-2 mt-2.5">
            {traders.map((t) => (
              <button
                key={t}
                className="btn btn-line mono text-[11px]"
                onClick={() => {
                  setAddr(t);
                  setTheirs(null);
                }}
              >
                {short(t, 6)}
              </button>
            ))}
          </div>
        </>
      )}

      <input
        value={addr}
        onChange={(e) => setAddr(e.target.value.trim())}
        placeholder="0x…"
        className="field mono w-full mt-3 px-3 py-2.5 text-[12px]"
        style={{ color: "var(--paper)", outline: "none" }}
      />
      <button
        className="btn btn-line w-full mt-2"
        disabled={!session || !addr || busy !== null}
        onClick={async () => {
          setBusy("theirs");
          try {
            setTheirs(await read(addr));
          } catch {
            setTheirs(null);
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "theirs" ? "Trying…" : "Try to read it"}
      </button>

      {theirs && (
        <>
          <Result rows={theirs} />

          {anyRefused && (
            <p className="fade-up text-[13px] mt-4 leading-relaxed" style={{ color: "var(--muted)" }}>
              <span style={{ color: "var(--red)" }}>Refused.</span> The reference
              is public and anyone can see it on-chain. The balance behind it
              belongs to its owner alone.
            </p>
          )}

          {/* Said plainly, because the alternative is a panel that appears to
              have just read a stranger's balance and got zero. */}
          {allEmpty && (
            <p className="fade-up text-[13px] mt-4 leading-relaxed" style={{ color: "var(--amber)" }}>
              That address has never deposited here, so its handle is the zero
              word and there is nothing to withhold. This proves nothing either
              way. Try one of the addresses above instead.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Result({ rows }: { rows: Row[] }) {
  return (
    <div className="fade-up mt-4 space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 text-[13px]">
          <span style={{ color: "var(--faint)" }}>{r.label}</span>
          <span className="mono text-[10px]" style={{ color: "var(--faint)" }}>
            {r.state === "empty" ? "no handle" : short(r.handle, 6)}
          </span>
          <span className="tnum text-right" style={{ minWidth: 88 }}>
            {r.state === "ok" ? (
              formatUnits(r.value!, r.decimals, 4)
            ) : r.state === "refused" ? (
              <span style={{ color: "var(--red)" }}>Refused</span>
            ) : (
              <span style={{ color: "var(--faint)" }}>Never deposited</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
