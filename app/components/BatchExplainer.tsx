"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { BatchLimits } from "@/lib/useBatch";

/// What the batch strip's one-line status actually means.
///
/// "Retrying settlement" reads as an error to anyone who has not read the
/// contract, when it is the price guard doing exactly its job. That is the one
/// thing this panel has to land, so it gets the space and the lifecycle gets a
/// line each — an explainer nobody scrolls to the end of explains nothing.
///
/// Every number is read from the deployed contract via `limits` rather than
/// written into the copy. These are Solidity `constant`s, so a redeployment can
/// change them, and prose that disagrees with the chain is worse than no prose.
export function BatchExplainer({
  open,
  onClose,
  limits,
  status,
}: {
  open: boolean;
  onClose: () => void;
  limits: BatchLimits;
  status: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Portalled to <body>, and it has to be. The caller renders this inside the
  // batch strip's `.glass` card, and `backdrop-filter` makes that card a
  // containing block for fixed-position descendants — so `fixed inset-0` sized
  // itself to a 440px card rather than the viewport, and the panel overflowed
  // it. Any ancestor gaining a filter or transform would reintroduce that, so
  // escaping to <body> is the fix rather than repositioning against the card.
  if (!open || typeof document === "undefined") return null;

  const steps = [
    { at: 0, name: "Collecting", body: `Orders pool for ${limits.win}s. Needs ${limits.min} to clear, stops at ${limits.max}.` },
    { at: 1, name: "Clearing", body: "Buys and sells net off encrypted. Only the leftover reaches the pool." },
    { at: 2, name: "Settled", body: "Everyone in the batch fills at one shared price." },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="How a batch settles"
    >
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
        onClick={onClose}
      />

      {/* dvh, not vh: mobile browsers count the collapsing URL bar in vh, so a
          panel sized to 85vh can still sit taller than the visible viewport. */}
      <div
        className="glass-strong relative w-full fade-up"
        style={{
          maxWidth: 360,
          padding: 16,
          maxHeight: "min(85dvh, 520px)",
          overflowY: "auto",
          overscrollBehavior: "contain",
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <p className="text-[14px] font-semibold tracking-tight">How a batch settles</p>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginTop: -6, marginRight: -6 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          {steps.map((s) => {
            const here = status === s.at;
            return (
              <div
                key={s.name}
                style={{
                  border: "1px solid",
                  borderColor: here ? "var(--line-2)" : "var(--line)",
                  borderRadius: 9,
                  padding: "8px 10px",
                  background: here ? "var(--ink-2)" : "transparent",
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] font-semibold">{s.name}</span>
                  {here && (
                    <span className="eyebrow ml-auto" style={{ color: "var(--red)" }}>
                      Now
                    </span>
                  )}
                </div>
                <p className="text-[11px] leading-snug mt-0.5" style={{ color: "var(--faint)" }}>
                  {s.body}
                </p>
              </div>
            );
          })}
        </div>

        <hr className="rule my-3" />

        <p className="text-[11.5px] font-semibold mb-0.5">Why “retrying”</p>
        <p className="text-[11px] leading-snug" style={{ color: "var(--faint)" }}>
          Settlement must land inside a price band fixed when the batch opened. If the pool drifted
          outside it, the trade is rejected and retried — the guard working, not a fault.
        </p>

        <p className="text-[11.5px] font-semibold mt-2.5 mb-0.5">You can’t get stuck</p>
        <p className="text-[11px] leading-snug" style={{ color: "var(--faint)" }}>
          Unsettled {formatTimeout(limits.settleTimeout)} after closing, the batch cancels and all
          collateral returns. Anyone can trigger it.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function formatTimeout(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}
