"use client";

import { useCallback, useState } from "react";
import { connect, type Session } from "./hashswap";

/// Wallet session, shared by every route.
///
/// Deliberately not a context provider: each page mounts its own instance, and
/// reconnecting is a single silent `eth_requestAccounts` when the wallet is
/// already authorised. A provider would buy nothing here except indirection.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const open = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      setSession(await connect());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  return { session, error, connecting, connect: open };
}
