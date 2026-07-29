"use client";

import { useCallback, useState } from "react";
import { connect, type Session } from "./hashswap";
import { DEFAULT_MARKET, getMarket } from "./markets";

/// Wallet session bound to a market.
///
/// Each market is a separate HashSwap deployment, so switching markets rebuilds
/// the session against different contracts rather than just re-rendering.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [marketId, setMarketId] = useState(DEFAULT_MARKET);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const open = useCallback(
    async (rdns?: string, nextMarket?: string) => {
      setError(null);
      setConnecting(true);
      try {
        setSession(await connect(rdns, nextMarket ?? marketId));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setConnecting(false);
      }
    },
    [marketId],
  );

  const selectMarket = useCallback(
    async (id: string) => {
      setMarketId(id);
      // Only reconnect if a wallet is already attached; otherwise the picker
      // just sets which market the next connection will use.
      if (session) await open(undefined, id);
    },
    [session, open],
  );

  return {
    session,
    market: session?.market ?? getMarket(marketId),
    marketId,
    selectMarket,
    error,
    connecting,
    connect: open,
  };
}
