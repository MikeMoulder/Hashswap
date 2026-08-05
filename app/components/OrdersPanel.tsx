"use client";

import { useState } from "react";
import { explain, type Session } from "@/lib/hashswap";
import type { BatchLimits, BatchView } from "@/lib/useBatch";
import type { LiveOrder } from "@/lib/useOrders";

/// Where an order lives once it is placed.
///
/// The swap card's timeline is a view of the session that placed the order, and
/// it dies with the tab. This is the durable one: it is derived entirely from
/// chain state, so a reload, a second tab, or a wallet reconnected an hour later
/// all show the same thing.
///
/// It also carries `withdrawIntent`, which had no surface at all before this
/// panel existed — see the note on the button below.

const STATUS = ["Collecting", "Clearing", "Settled", "Cancelled"];

export function OrdersPanel({
  session,
  order,
  batch,
  limits,
  secondsLeft,
  scanning,
  onActivity,
  onGoToSwap,
  findIntent,
}: {
  session: Session | null;
  order: LiveOrder | null;
  /// The batch the order is in. Always the current one — a live intent cannot be
  /// anywhere else (see `useOrders`).
  batch: BatchView | null;
  limits: BatchLimits | null;
  secondsLeft: number;
  scanning: boolean;
  onActivity: () => void;
  onGoToSwap: () => void;
  findIntent: (s: Session, batchId: bigint) => Promise<number | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <Empty>
        Connect a wallet to see orders. Nothing is stored in this browser — an
        order is read back from the chain, so it survives a refresh.
      </Empty>
    );
  }

  if (!order || !batch) {
    return (
      <Empty>
        {scanning ? (
          "Checking the open batch for your orders…"
        ) : (
          <>
            No open orders.{" "}
            <button className="link" onClick={onGoToSwap}>
              Place one
            </button>{" "}
            and it will appear here until it settles.
          </>
        )}
      </Empty>
    );
  }

  const open = batch.status === 0;

  /// A batch that has run out of window but cannot clear. `closeBatch` responds
  /// by rolling the window rather than settling, because settling below
  /// `MIN_BATCH_SIZE` would expose the few people in it (HashSwap.sol:394). In a
  /// quiet market that repeats indefinitely, and the collateral was already
  /// debited at submit time — so this is the state `withdrawIntent` exists for.
  const stalled = open && limits !== null && secondsLeft === 0 && batch.count < limits.min;

  async function withdraw() {
    if (!session || !order) return;
    setBusy(true);
    setError(null);
    try {
      // Re-derive the index instead of trusting the polled one. Between the last
      // poll and this click somebody else may have withdrawn, which swap-pops
      // the array and shifts whoever was last into their slot.
      const index = await findIntent(session, order.batchId);
      if (index === null) {
        throw new Error("This order is no longer in the batch — it may have just settled.");
      }

      // Simulate first, so a refusal arrives as a sentence here rather than as
      // an unexplained "this transaction will fail" warning in the wallet.
      try {
        await session.hashswap.withdrawIntent.staticCall(order.batchId, index);
      } catch (sim: any) {
        throw new Error(`The withdrawal would revert: ${explain(sim)}`);
      }

      await (await session.hashswap.withdrawIntent(order.batchId, index)).wait();
      onActivity();
    } catch (e: any) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-strong p-5" style={{ width: "100%", maxWidth: 440 }}>
      <div className="flex items-center justify-between mb-4">
        <span className="eyebrow">Your order</span>
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
          {open && <span className="dot" />}
          {STATUS[batch.status]}
        </span>
      </div>

      <div className="surface px-4 py-3.5">
        <Row label="Batch" value={String(batch.id).padStart(3, "0")} />
        <Row
          label="Position"
          value={
            <span style={{ color: "var(--muted)" }}>
              {order.index + 1} of {batch.count}
            </span>
          }
        />
        <Row
          label="Amount and side"
          value={<span style={{ color: "var(--green)" }}>Encrypted</span>}
        />
        <Row
          label={open ? "Clears" : "Settles"}
          value={
            open
              ? limits && batch.count < limits.min
                ? `Needs ${limits.min - batch.count} more order${limits.min - batch.count === 1 ? "" : "s"}`
                : secondsLeft > 0
                  ? `In ${secondsLeft}s`
                  : "Ready to close"
              : "Keeper is settling the residual"
          }
        />
      </div>

      {/* The one thing this panel exists to make reachable.
          `withdrawIntent` has been in the contract since Jul 27 as the fix for
          F16, and in the ABI, but nothing in the app called it — so a wallet
          stuck in a rolling batch had its collateral debited, no fill, and no
          way out, which is F16 exactly. It is also the only exit: `cancelBatch`
          requires a Closed batch (HashSwap.sol:621) and a rolling one never gets
          there. */}
      {open && (
        <>
          {stalled && (
            <p className="text-[12px] mt-4 leading-relaxed" style={{ color: "var(--amber)" }}>
              This batch has run out of window with too few orders to clear
              safely, so it keeps rolling. Your collateral is posted and no fill
              is coming until someone else joins. You can take it back.
            </p>
          )}

          <button className="btn btn-line w-full mt-4" disabled={busy} onClick={withdraw}>
            {busy ? "Withdrawing" : "Withdraw order"}
          </button>

          {/* Stated because it is the one place using this app costs privacy,
              and the contract is explicit about it (HashSwap.sol:330-332). */}
          <p className="text-[11px] mt-2.5 leading-relaxed" style={{ color: "var(--faint)" }}>
            Returns exactly what you posted. Leaving a batch is public — an
            observer learns this address withdrew, though not the amount or which
            way you were trading.
          </p>
        </>
      )}

      {!open && (
        <p className="text-[12px] mt-4 leading-relaxed" style={{ color: "var(--faint)" }}>
          The batch is closed and the residual is being decrypted and swapped.
          Orders cannot be withdrawn once closing has begun — this is the point
          where collateral is committed to a fill.
        </p>
      )}

      {error && (
        <p className="text-[12px] mono mt-4" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="glass px-5 py-8 text-[13px] text-center leading-relaxed"
      style={{ width: "100%", maxWidth: 440, color: "var(--faint)" }}
    >
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-[13px]">
      <span style={{ color: "var(--faint)" }}>{label}</span>
      <span className="tnum">{value}</span>
    </div>
  );
}
