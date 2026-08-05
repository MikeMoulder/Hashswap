"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchLimits, BatchView } from "@/lib/useBatch";
import { formatUnits, type Market } from "@/lib/markets";

/// The order lifecycle, drawn.
///
/// A private swap is not one transaction, it is eight states across two parties
/// and a delay, and most of it happens after the user's last click. Without a
/// picture of that, the wait after "Place private order" is indistinguishable
/// from the app having hung. So the flow is drawn ahead of time, from the moment
/// an amount is typed, and each step lights up as it is reached.
///
/// It also carries the argument. Every step states what the chain can see at
/// that point, which is the whole product: three of the eight steps are public
/// and stay public, and the rest never leave the enclave.

export type StepState = "todo" | "active" | "done" | "skipped" | "failed";

export type FlowStep = {
  key: string;
  title: string;
  note: string;
  /// What an observer watching the chain learns at this step.
  chain: string;
  visibility: "public" | "private";
  state: StepState;
};

/// Local progress through the two funding transactions and the two submission
/// steps. Everything after that is read from the chain, not from here.
export type LocalStage = "idle" | "approving" | "depositing" | "sealing" | "submitting" | "queued";

export function buildFlow({
  stage,
  market,
  sellSymbol,
  amount,
  alreadyFunded,
  fundedNow,
  failedAt,
  submitted,
  batch,
  limits,
  secondsLeft,
}: {
  stage: LocalStage;
  market: Market;
  sellSymbol: string;
  amount: string;
  alreadyFunded: boolean;
  /// Whether this run is paying for its own collateral.
  ///
  /// `alreadyFunded` is read off the vault balance, so it becomes true the
  /// instant the deposit confirms — and again once the amount field clears on
  /// submission. Either would rewrite the two funding steps as "skipped" after
  /// the user had just watched them run.
  fundedNow: boolean;
  failedAt: string | null;
  /// Whether this wallet actually has an intent in `batch`.
  ///
  /// The batch is polled from the moment the wallet connects, so without this
  /// the last four steps would light up off someone else's activity and show a
  /// stranger's batch settling as though it were your order.
  submitted: boolean;
  batch: BatchView | null;
  limits: BatchLimits | null;
  secondsLeft: number;
}): FlowStep[] {
  const past = (...stages: LocalStage[]) => stages.includes(stage);

  /// Whether funding is not part of this order at all — the vault already
  /// covered it. Distinct from `alreadyFunded`, which also goes true the moment
  /// a deposit made *for* this order lands.
  const skipped = !fundedNow && (alreadyFunded || submitted);

  /// Funding is two transactions, kept separate because either can fail on its
  /// own and a demo that collapses them cannot show which did. When the vault
  /// balance already covers the order they are marked skipped rather than
  /// hidden, so the path does not change shape underneath the user.
  const fundState = (self: LocalStage): StepState => {
    if (failedAt === self) return "failed";
    if (stage === self) return "active";
    if (skipped) return "skipped";
    if (self === "approving" && past("depositing", "sealing", "submitting", "queued")) return "done";
    if (self === "depositing" && past("sealing", "submitting", "queued")) return "done";
    return "todo";
  };

  const seal: StepState =
    failedAt === "sealing"
      ? "failed"
      : stage === "sealing"
        ? "active"
        : past("submitting", "queued") || submitted
          ? "done"
          : "todo";

  const submit: StepState =
    failedAt === "submitting"
      ? "failed"
      : stage === "submitting"
        ? "active"
        : submitted
          ? "done"
          : "todo";

  // 0 Open, 1 Closed, 2 Settled, 3 Cancelled. Held at -1 until the intent is in,
  // which leaves everything downstream at "todo" and drawn as the path ahead.
  const status = submitted ? (batch?.status ?? -1) : -1;
  const cancelled = status === 3;

  const collect: StepState = cancelled
    ? "failed"
    : status === 0
      ? "active"
      : status >= 1
        ? "done"
        : "todo";

  // `closeBatch` is what nets. By the time the batch reads Closed the crossing
  // has already happened on-chain and the residual is waiting on the keeper.
  const net: StepState = cancelled ? "failed" : status >= 1 ? "done" : "todo";
  const settle: StepState = cancelled
    ? "failed"
    : status === 2
      ? "done"
      : status === 1
        ? "active"
        : "todo";
  const fill: StepState = status === 2 ? "done" : "todo";

  const short = limits && batch ? Math.max(0, limits.min - batch.count) : 0;
  const cover = !batch
    ? "Waits with other orders until there are enough to hide in"
    : short > 0
      ? `${batch.count} of ${limits?.min ?? "?"} orders, ${short} more needed to clear`
      : `${batch.count} orders in, enough cover to clear${secondsLeft > 0 ? ` in ${secondsLeft}s` : ""}`;

  return [
    {
      key: "approving",
      title: "Approve",
      note: skipped
        ? "Vault already holds enough, nothing to approve"
        : `Let the vault move ${amount || "your"} ${sellSymbol}`,
      chain: "A standard ERC-20 approval",
      visibility: "public",
      state: fundState("approving"),
    },
    {
      key: "depositing",
      title: "Deposit",
      note: skipped
        ? `Skipped. This order is collateralised from ${sellSymbol} already sitting in your vault`
        : `Move ${amount || "the amount"} ${sellSymbol} into the confidential vault`,
      // Skipping these two steps is the privacy mechanism, not a shortcut. A
      // deposit that matches an intent in size and timing links the two, so the
      // system is working as intended precisely when the trade needs no transfer.
      chain: skipped ? "Nothing. No transfer happens for this trade" : "The transfer, and its amount",
      visibility: skipped ? "private" : "public",
      state: fundState("depositing"),
    },
    {
      key: "sealing",
      title: "Seal the order",
      note: "Amount and side are encrypted inside the TEE",
      chain: "Nothing yet, this step is off-chain",
      visibility: "private",
      state: seal,
    },
    {
      key: "submitting",
      title: "Submit",
      note: "Added to the batch's encrypted running totals",
      chain: "That you placed an order. Not what, not which way",
      visibility: "private",
      state: submit,
    },
    {
      key: "collect",
      title: "Collect",
      note: cover,
      chain: "How many orders are in the batch",
      visibility: "private",
      state: collect,
    },
    {
      key: "net",
      title: "Cross internally",
      note: "Buys and sells cancel out, C = min(B, S), and never reach the pool",
      chain: "Nothing. The crossed volume is never decrypted",
      visibility: "private",
      state: net,
    },
    {
      key: "settle",
      title: "Settle the residual",
      note:
        status === 2 && batch
          ? `${formatUnits(batch.residual, 18, 4)} reached Uniswap`
          : `Only R = |B - S| is decrypted, then swapped once on ${market.base.symbol}/${market.quote.symbol}`,
      chain: "The residual, and one Uniswap swap. This is the only number that leaks",
      visibility: "public",
      state: settle,
    },
    {
      key: "fill",
      title: "Fill",
      note:
        status === 2 && batch
          ? `Cleared at ${formatUnits(batch.clearingPrice, 18, 4)}`
          : "Everyone fills at the residual's realised price",
      chain: "Nothing. Per-user fills stay encrypted",
      visibility: "private",
      state: fill,
    },
  ];
}

export function SwapFlow({ steps }: { steps: FlowStep[] }) {
  const done = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const activeIndex = steps.findIndex((s) => s.state === "active" || s.state === "failed");

  const scroller = useRef<HTMLOListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  /// Which edges have content hidden past them.
  ///
  /// The fade masks used to be permanent, which meant the very first step was
  /// drawn half-faded even when the list was already scrolled to the top and
  /// there was nothing above it — it just looked clipped. A fade should only
  /// exist where something is actually being cut off.
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      top: el.scrollTop > 4,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 4,
    });
  }, []);

  useEffect(measure, [measure, steps.length]);

  /// Keep the current step in view.
  ///
  /// The timeline is taller than its window by design, so without this the
  /// interesting row scrolls out of sight exactly when it starts happening.
  /// `block: "nearest"` scrolls the list itself and not the page.
  useEffect(() => {
    const el = activeRef.current;
    if (!el || !scroller.current) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // Let the smooth scroll land before deciding which edges are cut off.
    const t = setTimeout(measure, 380);
    return () => clearTimeout(t);
  }, [activeIndex, measure]);

  return (
    <div className="flow">
      <div className="flex items-center justify-between mb-3">
        <span className="eyebrow">Order lifecycle</span>
        <span className="text-[11px] tnum" style={{ color: "var(--faint)" }}>
          {activeIndex < 0 ? `${done} of ${steps.length}` : `Step ${activeIndex + 1} of ${steps.length}`}
        </span>
      </div>

      {/* A window onto the timeline rather than the whole thing at once. Eight
          steps of explanation pushed the batch strip and everything below it off
          the screen, so the list scrolls inside a fixed frame and follows the
          active step. The progress bar on the left is the full timeline, so the
          part being looked at stays locatable. */}
      <div className="flow-frame">
        <span className="flow-progress" style={{ ["--p" as any]: `${(done / steps.length) * 100}%` }} />
        <ol
          className="flow-list"
          ref={scroller}
          onScroll={measure}
          data-fade-top={edges.top}
          data-fade-bottom={edges.bottom}
        >
          {steps.map((step, i) => (
          <li
            key={step.key}
            ref={i === activeIndex ? activeRef : undefined}
            className="flow-step"
            data-state={step.state}
            /* Staggered so the list assembles itself top to bottom instead of
               appearing all at once, which reads as a page that has not
               finished loading. */
            style={{ ["--i" as any]: i }}
          >
            <div className="flow-gutter">
              <span className="flow-node" aria-hidden>
                {step.state === "done" && (
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
                {step.state === "failed" && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M5 5l14 14M19 5L5 19"
                      stroke="currentColor"
                      strokeWidth="3.4"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
                {step.state === "active" && <span className="flow-spin" />}
              </span>
              {i < steps.length - 1 && <span className="flow-rail" />}
            </div>

            <div className="flow-body">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="flow-title">{step.title}</span>
                <span className="flow-vis" data-vis={step.visibility}>
                  {step.visibility}
                </span>
              </div>
              <p className="flow-note">{step.note}</p>
              <p className="flow-chain">
                <span style={{ color: "var(--faint)" }}>Chain sees</span> {step.chain}
              </p>
            </div>
          </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
