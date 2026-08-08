"use client";

import { useEffect } from "react";
import type { BatchLimits } from "@/lib/useBatch";

/// What the batch strip's one-line status actually means.
///
/// The strip has room for three words — "Retrying settlement" reads as an error
/// to anyone who has not read the contract, when it is the price guard doing
/// exactly its job. The states that need explaining are the ones a trader has no
/// way to interpret from the label alone: why a batch waits, why a settlement
/// retries, and why neither can strand them.
///
/// Every number here is read from the deployed contract via `limits` rather than
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

  if (!open) return null;

  const steps = [
    {
      at: 0,
      name: "Collecting",
      body: `Your order joins a batch instead of going straight to the pool. The batch stays open for ${limits.win}s and needs ${limits.min} orders before it can clear — below that there is no crowd to hide in, so the contract refuses to settle rather than expose the few who showed up. It stops accepting at ${limits.max}.`,
    },
    {
      at: 1,
      name: "Clearing",
      body: "Buys and sells cancel each other out while still encrypted. Only the leftover — the residual — is sent to Uniswap, so the pool sees one net trade rather than yours. This is the step that makes your size invisible.",
    },
    {
      at: 2,
      name: "Settled",
      body: "The residual traded and every participant was filled at one shared clearing price. Nobody in the batch got a better price than anybody else.",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="How a batch settles"
    >
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
        onClick={onClose}
      />

      <div
        className="glass-strong relative w-full fade-up"
        style={{ maxWidth: 400, padding: 18, maxHeight: "85vh", overflowY: "auto" }}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">How a batch settles</p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--faint)" }}>
              Nothing here needs you to act
            </p>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginTop: -2, marginRight: -4 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-2.5">
          {steps.map((s, i) => {
            const here = status === s.at;
            return (
              <div
                key={s.name}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: here ? "var(--ink-2)" : "transparent",
                  borderColor: here ? "var(--line-2)" : "var(--line)",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="tnum text-[10px]" style={{ color: "var(--faint)" }}>
                    {i + 1}
                  </span>
                  <span className="text-[12px] font-semibold">{s.name}</span>
                  {here && (
                    <span className="eyebrow ml-auto" style={{ color: "var(--red)" }}>
                      You are here
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--faint)" }}>
                  {s.body}
                </p>
              </div>
            );
          })}
        </div>

        <hr className="rule my-3.5" />

        <p className="text-[12px] font-semibold mb-1">Why it says “retrying”</p>
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--faint)" }}>
          Settlement has to execute inside a price band fixed when the batch opened. If the pool has
          drifted outside that band, the contract rejects the trade and it is tried again. That is
          the guard working, not a fault — it is refusing to fill you at a price nobody in the batch
          funded. A pool that drifts back in range settles normally.
        </p>

        <p className="text-[12px] font-semibold mt-3 mb-1">You cannot get stuck</p>
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--faint)" }}>
          If a batch still has not settled {formatTimeout(limits.settleTimeout)} after it closed, it
          is cancelled and every participant’s collateral is returned in full. Anyone can trigger
          that refund, so it does not depend on us staying online.
        </p>

        <p className="text-[11px] mt-3 leading-relaxed" style={{ color: "var(--faint)" }}>
          You can pull your order back out while the batch is still collecting. Once it closes you
          are in until it settles or refunds.
        </p>
      </div>
    </div>
  );
}

function formatTimeout(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds}s`;
}
