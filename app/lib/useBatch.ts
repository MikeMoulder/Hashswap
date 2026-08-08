"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "./hashswap";

/// Live batch state, polled once for the whole page.
///
/// Both the swap card and the batch strip need this, and both used to poll it
/// themselves — two `currentBatchId` + `getBatch` round trips every few seconds
/// against the same block, disagreeing with each other in between. One hook,
/// one source of truth, passed down.

export type BatchView = {
  id: bigint;
  count: number;
  status: number;
  openedAt: number;
  closedAt: number;
  refPrice: bigint;
  residual: bigint;
  clearingPrice: bigint;
  residualIsSell: boolean;
};

export type BatchLimits = {
  min: number;
  max: number;
  win: number;
  settleTimeout: number;
  bufferBps: bigint;
};

const POLL_MS = 6000;

function toView(id: bigint, b: any): BatchView {
  return {
    id,
    count: Number(b.count),
    status: Number(b.status),
    openedAt: Number(b.openedAt),
    closedAt: Number(b.closedAt),
    refPrice: b.refPrice,
    residual: b.residual,
    clearingPrice: b.clearingPrice,
    residualIsSell: Boolean(b.residualIsSell),
  };
}

/// @param watchId a batch the caller has an intent in. It keeps being read after
///        `currentBatchId` has moved on, which is the only way to follow an
///        order through settlement — the pointer advances the moment the batch
///        closes, so watching "current" alone loses sight of it exactly when the
///        interesting part starts.
export function useBatch(session: Session | null, tick: number, watchId?: bigint | null) {
  const [current, setCurrent] = useState<BatchView | null>(null);
  const [watched, setWatched] = useState<BatchView | null>(null);
  const [limits, setLimits] = useState<BatchLimits | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // A ref, not a dependency: the poll closure reads the latest id without the
  // interval being torn down and rebuilt every time a batch is submitted.
  const watchRef = useRef<bigint | null>(null);
  watchRef.current = watchId ?? null;

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
    const id: bigint = await session.hashswap.currentBatchId();
    const cur = toView(id, await session.hashswap.getBatch(id));
    setCurrent(cur);

    const w = watchRef.current;
    if (w == null) setWatched(null);
    else if (w === id) setWatched(cur);
    else setWatched(toView(w, await session.hashswap.getBatch(w)));
  }, [session]);

  // Immutable per deployment, so they are read once per session rather than on
  // every poll.
  useEffect(() => {
    if (!session) {
      setLimits(null);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const [min, max, win, settleTimeout, buffer] = await Promise.all([
          session.hashswap.MIN_BATCH_SIZE(),
          session.hashswap.MAX_BATCH_SIZE(),
          session.hashswap.BATCH_WINDOW(),
          session.hashswap.SETTLE_TIMEOUT(),
          // Read, not copied. The client needs this to size a buy's collateral,
          // and a stale local copy below the contract's produces orders that
          // look placed and contribute nothing.
          session.hashswap.BUFFER_BPS(),
        ]);
        if (!dead)
          setLimits({
            min: Number(min),
            max: Number(max),
            win: Number(win),
            settleTimeout: Number(settleTimeout),
            bufferBps: BigInt(buffer),
          });
      } catch {
        /* transient RPC; the next session change retries */
      }
    })();
    return () => {
      dead = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) {
      setCurrent(null);
      setWatched(null);
      return;
    }
    let dead = false;
    const run = () => {
      load().catch(() => {
        /* transient */
      });
    };
    run();
    const p = setInterval(() => {
      if (!dead) run();
    }, POLL_MS);
    return () => {
      dead = true;
      clearInterval(p);
    };
  }, [session, tick, load]);

  /// Seconds left in the collection window, or 0 once it has elapsed.
  const secondsLeft = (b: BatchView | null) =>
    b && limits ? Math.max(0, limits.win - (now - b.openedAt)) : 0;

  /// A Closed batch is either settled by the keeper or refunded once this
  /// reaches zero. Showing that bound avoids presenting a price-guard retry as
  /// an infinite spinner.
  const secondsUntilCancellation = (b: BatchView | null) =>
    b && limits && b.status === 1 ? Math.max(0, limits.settleTimeout - (now - b.closedAt)) : 0;

  return { current, watched, limits, now, secondsLeft, secondsUntilCancellation, refresh: load };
}
