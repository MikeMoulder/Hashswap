"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "./hashswap";
import type { BatchView } from "./useBatch";

/// The connected wallet's live order, read back off the chain.
///
/// Nothing about an order is kept in the browser. The swap card's own state
/// covers the session that placed it; this covers every other case — a reload
/// mid-flight, a second tab, a wallet reconnected an hour later — where the
/// chain still holds an order the UI has forgotten about. Local storage would
/// only ever be a second, staler copy of something already on-chain.
///
/// **Only the current batch has to be searched.** `_openBatch` runs in exactly
/// two places, `settle` and `cancelBatch` (HashSwap.sol:512, :641), and both
/// resolve every intent in the outgoing batch before advancing the pointer. So
/// an intent in any earlier batch has already been filled or refunded, and a
/// wallet can hold at most one live order — always in `currentBatchId`.

export type LiveOrder = {
  batchId: bigint;
  /// Position in `_intents[batchId]` as of this poll, and no longer.
  ///
  /// Deliberately re-derived rather than remembered. `withdrawIntent` fills the
  /// vacated slot by swapping the last entry into it (HashSwap.sol:355), so any
  /// index held across someone else's withdrawal now points at a different
  /// person's intent — where the owner check rejects it.
  index: number;
};

export function useOrders(session: Session | null, current: BatchView | null, tick: number) {
  const [order, setOrder] = useState<LiveOrder | null>(null);
  const [scanning, setScanning] = useState(false);

  /// Find this wallet's intent in a batch, or null. Bounded by `MAX_BATCH_SIZE`
  /// (8), so the whole scan is one round of parallel `eth_call`s — these are
  /// plain view reads, not decrypts, so unlike the vault balances they carry no
  /// signature prompt to serialise.
  const findIntent = useCallback(
    async (s: Session, batchId: bigint): Promise<number | null> => {
      const n = Number(await s.hashswap.intentCount(batchId));
      if (n === 0) return null;

      const intents = await Promise.all(
        Array.from({ length: n }, (_, i) => s.hashswap.getIntent(batchId, i)),
      );

      const me = s.address.toLowerCase();
      const i = intents.findIndex((it: any) => String(it.user).toLowerCase() === me);
      return i < 0 ? null : i;
    },
    [],
  );

  /// Which scan is the current one. A batch filling up re-triggers the effect
  /// faster than a scan completes, and without this the loser of that race lands
  /// last and installs a membership snapshot that is already out of date.
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    const settle = (v: LiveOrder | null) => {
      if (gen.current !== mine) return;
      setOrder(v);
      setScanning(false);
    };

    if (!session || !current) return settle(null);

    // Settled and Cancelled are terminal, and the pointer has moved past them by
    // definition — but a poll can catch the old view for a beat, and reporting a
    // live order against a settled batch would offer a withdrawal that cannot
    // work.
    if (current.status > 1) return settle(null);

    setScanning(true);
    try {
      const index = await findIntent(session, current.id);
      settle(index === null ? null : { batchId: current.id, index });
    } catch (e) {
      if (gen.current === mine) setScanning(false);
      throw e;
    }
  }, [session, current, findIntent]);

  useEffect(() => {
    if (!session) {
      setOrder(null);
      return;
    }
    load().catch(() => {
      /* transient RPC; the next poll retries */
    });
    // `current` as a whole changes identity on every poll, so the scan keys off
    // the two fields that can actually change the answer: which batch is open,
    // and whether its membership moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, current?.id, current?.count, current?.status, tick]);

  return { order, scanning, refresh: load, findIntent };
}
