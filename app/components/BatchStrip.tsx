"use client";

import { useState } from "react";
import { fmt, type Session } from "@/lib/hashswap";
import type { BatchLimits, BatchView } from "@/lib/useBatch";

const STATUS = ["Collecting", "Clearing", "Settled", "Cancelled"];

/// Live batch state, phrased for a trader rather than an engineer. The meter is
/// the argument: filled marks are the people you are hiding among, and the dark
/// red marks are the floor below which the contract refuses to settle.
///
/// Batch data arrives as props now. It used to poll for itself, which meant two
/// components asking the same node the same question on different timers and
/// disagreeing in between.
export function BatchStrip({
  session,
  batch,
  limits,
  secondsLeft,
  onActivity,
}: {
  session: Session | null;
  batch: BatchView | null;
  limits: BatchLimits | null;
  secondsLeft: number;
  onActivity: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session || !batch || !limits) {
    return (
      <div
        className="glass px-5 py-4 mt-3 text-[12px]"
        style={{ maxWidth: 440, width: "100%", color: "var(--faint)" }}
      >
        {session ? "Loading batch" : "Connect to follow the live batch"}
      </div>
    );
  }

  const ready = batch.count >= limits.min;
  const canClose = batch.status === 0 && (secondsLeft === 0 || batch.count >= limits.max);

  return (
    <div className="glass px-5 py-4 mt-3" style={{ maxWidth: 440, width: "100%" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="eyebrow">Batch {String(batch.id).padStart(3, "0")}</span>
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
          {batch.status === 0 && <span className="dot" />}
          {STATUS[batch.status]}
          {batch.status === 0 && secondsLeft > 0 && (
            <span className="tnum" style={{ color: "var(--faint)" }}>
              · {secondsLeft}s
            </span>
          )}
        </span>
      </div>

      <div className="meter">
        {Array.from({ length: limits.max }).map((_, i) => (
          <span key={i} data-on={i < batch.count} data-required={i >= batch.count && i < limits.min} />
        ))}
      </div>

      <p className="text-[12px] mt-2.5" style={{ color: "var(--faint)" }}>
        {ready ? (
          <>
            <span style={{ color: "var(--muted)" }}>{batch.count} orders</span>, enough cover to
            clear
          </>
        ) : (
          <>
            <span style={{ color: "var(--muted)" }}>{batch.count} orders</span>,{" "}
            {limits.min - batch.count} more before this batch can clear
          </>
        )}
      </p>

      {batch.status === 2 && (
        <>
          <hr className="rule my-3" />
          <div className="flex justify-between text-[12px]">
            <span style={{ color: "var(--faint)" }}>Reached the pool</span>
            <span className="tnum" style={{ color: "var(--red)" }}>
              {fmt(batch.residual, 2)}
            </span>
          </div>
          <div className="flex justify-between text-[12px] mt-1.5">
            <span style={{ color: "var(--faint)" }}>Cleared at</span>
            <span className="tnum">{fmt(batch.clearingPrice, 2)}</span>
          </div>
        </>
      )}

      {batch.status === 0 && (
        <button
          className="btn btn-line w-full mt-4"
          disabled={!canClose || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await (await session.hashswap.closeBatch()).wait();
              onActivity();
            } catch (e: any) {
              setError(e?.shortMessage ?? e?.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Closing" : canClose ? "Close batch" : `Closes in ${secondsLeft}s`}
        </button>
      )}

      {error && (
        <p className="text-[11px] mono mt-3" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
