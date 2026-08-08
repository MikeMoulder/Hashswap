"use client";

import { useState } from "react";
import { fmt, type Session } from "@/lib/hashswap";
import type { BatchLimits, BatchView } from "@/lib/useBatch";
import { BatchExplainer } from "./BatchExplainer";

const STATUS = ["Collecting", "Clearing", "Settled", "Cancelled"];

/// Live batch state, phrased for a trader rather than an engineer. The meter is
/// the argument: filled marks are the people you are hiding among, and the dark
/// red marks are the floor below which the contract refuses to settle.
///
/// Batch data arrives as props now. It used to poll for itself, which meant two
/// components asking the same node the same question on different timers and
/// disagreeing in between.
///
/// Read-only, deliberately. This used to carry a "Close batch" button wired to
/// `closeBatch()`, which was a manual override for a job the keeper already does
/// on its own (`scripts/keeper.ts`) — and it was enabled on the wrong condition:
/// it checked the window and `MAX_BATCH_SIZE` but never `MIN_BATCH_SIZE`, so
/// below the floor the call succeeded, rolled the window (HashSwap.sol:394), and
/// changed nothing an observer could see. A live button that costs gas to do
/// nothing is worse than no button.
export function BatchStrip({
  session,
  batch,
  limits,
  secondsLeft,
  settlementSecondsLeft,
}: {
  session: Session | null;
  batch: BatchView | null;
  limits: BatchLimits | null;
  secondsLeft: number;
  settlementSecondsLeft: number;
}) {
  // Above the early return — this component bails out before rendering when the
  // session or batch is still loading, and a conditional hook would break.
  const [explaining, setExplaining] = useState(false);

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

  return (
    <div className="glass px-5 py-4 mt-3" style={{ maxWidth: 440, width: "100%" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="eyebrow">Batch {String(batch.id).padStart(3, "0")}</span>
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
          {batch.status === 0 && <span className="dot" />}
          {batch.status === 1 ? "Retrying settlement" : STATUS[batch.status]}
          {batch.status === 0 && secondsLeft > 0 && (
            <span className="tnum" style={{ color: "var(--faint)" }}>
              · {secondsLeft}s
            </span>
          )}
          {batch.status === 1 && (
            <span className="tnum" style={{ color: "var(--faint)" }}>
              · refunds in {formatWait(settlementSecondsLeft)}
            </span>
          )}
          {/* Sits with the status rather than the header: it is the status
              wording that needs explaining, not the batch number. */}
          <button
            className="info-dot"
            onClick={() => setExplaining(true)}
            aria-label="How a batch settles"
            aria-haspopup="dialog"
            aria-expanded={explaining}
          >
            {/* Tight viewBox on purpose: the glyph has ~13px of interior to
                fill, so a 24-unit box would render the stem barely 2px tall. */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="6" cy="2.9" r="0.95" fill="currentColor" />
              <path
                d="M6 5.3v3.9"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </span>
      </div>

      <BatchExplainer
        open={explaining}
        onClose={() => setExplaining(false)}
        limits={limits}
        status={batch.status}
      />

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

      {/* Replaces the button rather than just dropping it. Without a control
          here, the next question is who advances the batch and when — and the
          honest answer is nobody the user has to be. */}
      {batch.status === 0 && (
        <p className="text-[11px] mt-3" style={{ color: "var(--faint)" }}>
          {ready
            ? "Closes and settles on its own, no action needed."
            : "Waits for more orders. Nothing settles until there are enough to hide in."}
        </p>
      )}
    </div>
  );
}

function formatWait(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}
