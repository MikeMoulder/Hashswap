"use client";

import { useState } from "react";
import { useSession } from "@/lib/useSession";
import { useBatch } from "@/lib/useBatch";
import { requestConnect } from "@/lib/hashswap";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { SwapCard } from "@/components/SwapCard";
import { BatchStrip } from "@/components/BatchStrip";
import { VaultCard } from "@/components/VaultCard";
import { Backdrop } from "@/components/Backdrop";

/// The landing page IS the app. Someone arriving at a trading product should be
/// able to trade, not read a brochure first: the explanation lives at /home for
/// anyone who wants it.
export default function TradePage() {
  const { session, connect, connecting, error, market, selectMarket, disconnect } = useSession();
  const [tick, setTick] = useState(0);

  /// The batch the connected wallet has an order in. Held here rather than in
  /// the card because it has to outlive `currentBatchId` moving on, and both the
  /// card and the strip read from the same poll.
  const [watchId, setWatchId] = useState<bigint | null>(null);

  const { current, watched, limits, secondsLeft } = useBatch(session, tick, watchId);

  // Before submitting, the open batch is a preview of what the order would join.
  // After, it is the user's own batch, followed past `currentBatchId` moving on.
  const mine = watched ?? current;

  return (
    <main className="min-h-screen flex flex-col relative">
      <Backdrop />
      <Nav
        session={session}
        onConnect={connect}
        connecting={connecting}
        error={error}
        onDisconnect={disconnect}
      />

      <div className="relative flex-1 flex justify-center px-6 pt-10 pb-20">
        <div className="w-full flex flex-col items-center" style={{ maxWidth: 440 }}>
          {error && (
            <div
              className="surface px-4 py-3 mb-3 text-[12px] mono w-full"
              style={{ color: "var(--red)" }}
            >
              {error}
            </div>
          )}

          <SwapCard
            session={session}
            refPrice={current?.refPrice ?? null}
            onActivity={() => setTick((t) => t + 1)}
            onConnect={requestConnect}
            connecting={connecting}
            market={market}
            onSelectMarket={selectMarket}
            batch={mine}
            limits={limits}
            secondsLeft={secondsLeft(mine)}
            onWatchBatch={setWatchId}
          />

          {/* Only once there is an order in one. Before that the strip was
              reporting on a batch the user had no stake in, which read as their
              own position and told them nothing they could act on. */}
          {watchId !== null && (
            <BatchStrip
              session={session}
              batch={watched}
              limits={limits}
              secondsLeft={secondsLeft(watched)}
              onActivity={() => setTick((t) => t + 1)}
            />
          )}

          <VaultCard
            session={session}
            market={market}
            onActivity={() => setTick((t) => t + 1)}
          />

          {/* Nothing else here. The privacy check moved to /docs#verify and is
              reachable from the footer — it is a claim to audit, not a step in
              placing a trade, and anything sitting under the swap card reads as
              part of the flow. */}
        </div>
      </div>

      <Footer />
    </main>
  );
}
