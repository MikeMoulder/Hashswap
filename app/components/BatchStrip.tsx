"use client";

import { useEffect, useState } from "react";
import { fmt, type Session } from "@/lib/hashswap";

const STATUS = ["Collecting", "Clearing", "Settled", "Cancelled"];

/// Live batch state, phrased for a trader rather than an engineer. The meter is
/// the argument: filled marks are the people you are hiding among, and the dark
/// red marks are the floor below which the contract refuses to settle.
export function BatchStrip({ session, tick }: { session: Session | null; tick: number }) {
  const [s, setS] = useState<any>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!session) return;
    let dead = false;
    const load = async () => {
      try {
        const id = await session.hashswap.currentBatchId();
        const b = await session.hashswap.getBatch(id);
        const [min, max, win] = await Promise.all([
          session.hashswap.MIN_BATCH_SIZE(),
          session.hashswap.MAX_BATCH_SIZE(),
          session.hashswap.BATCH_WINDOW(),
        ]);
        if (!dead)
          setS({
            id,
            count: Number(b.count),
            status: Number(b.status),
            openedAt: Number(b.openedAt),
            residual: b.residual,
            clearingPrice: b.clearingPrice,
            min: Number(min),
            max: Number(max),
            win: Number(win),
          });
      } catch {
        /* transient */
      }
    };
    load();
    const p = setInterval(load, 8000);
    return () => {
      dead = true;
      clearInterval(p);
    };
  }, [session, tick]);

  if (!session || !s) {
    return (
      <div className="surface px-5 py-4 mt-3 text-[12px]" style={{ maxWidth: 440, width: "100%", color: "var(--faint)" }}>
        {session ? "Loading batch…" : "Connect to follow the live batch"}
      </div>
    );
  }

  const left = Math.max(0, s.win - (now - s.openedAt));
  const ready = s.count >= s.min;
  const canClose = s.status === 0 && (left === 0 || s.count >= s.max);

  return (
    <div className="surface px-5 py-4 mt-3" style={{ maxWidth: 440, width: "100%" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="eyebrow">Batch {String(s.id).padStart(3, "0")}</span>
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
          {s.status === 0 && <span className="dot" />}
          {STATUS[s.status]}
          {s.status === 0 && left > 0 && <span className="tnum" style={{ color: "var(--faint)" }}>· {left}s</span>}
        </span>
      </div>

      <div className="meter">
        {Array.from({ length: s.max }).map((_, i) => (
          <span key={i} data-on={i < s.count} data-required={i >= s.count && i < s.min} />
        ))}
      </div>

      <p className="text-[12px] mt-2.5" style={{ color: "var(--faint)" }}>
        {ready ? (
          <>
            <span style={{ color: "var(--muted)" }}>{s.count} orders</span> — enough
            cover to clear
          </>
        ) : (
          <>
            <span style={{ color: "var(--muted)" }}>{s.count} orders</span> — {s.min - s.count} more
            before this batch can clear
          </>
        )}
      </p>

      {s.status === 2 && (
        <>
          <hr className="rule my-3" />
          <div className="flex justify-between text-[12px]">
            <span style={{ color: "var(--faint)" }}>Reached the pool</span>
            <span className="tnum" style={{ color: "var(--red)" }}>{fmt(s.residual, 2)} hBASE</span>
          </div>
          <div className="flex justify-between text-[12px] mt-1.5">
            <span style={{ color: "var(--faint)" }}>Cleared at</span>
            <span className="tnum">{fmt(s.clearingPrice, 2)}</span>
          </div>
        </>
      )}

      {s.status === 0 && (
        <button
          className="btn btn-line w-full mt-4"
          disabled={!canClose || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await (await session.hashswap.closeBatch()).wait();
            } catch (e: any) {
              alert(e?.shortMessage ?? e?.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Closing…" : canClose ? "Close batch" : `Closes in ${left}s`}
        </button>
      )}
    </div>
  );
}
