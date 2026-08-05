"use client";

import { useState } from "react";
import { useSession } from "@/lib/useSession";
import { useBatch } from "@/lib/useBatch";
import { useOrders } from "@/lib/useOrders";
import { requestConnect } from "@/lib/hashswap";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { SwapCard } from "@/components/SwapCard";
import { BatchStrip } from "@/components/BatchStrip";
import { OrdersPanel } from "@/components/OrdersPanel";
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

  /// The wallet's live order, derived from chain state rather than remembered.
  /// This is what makes an order survive a refresh — and what tells the swap
  /// card that another one cannot be placed yet.
  const { order, scanning, findIntent } = useOrders(session, current, tick);

  const [tab, setTab] = useState<"swap" | "orders">("swap");

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

          {/* Placing an order and tracking one are separate jobs. Keeping them
              in one column meant a placed order either cluttered the card it was
              placed from, or vanished entirely on refresh — the chain still had
              it, the page did not. */}
          <div className="tabs">
            <button className="tab" data-on={tab === "swap"} onClick={() => setTab("swap")}>
              Swap
            </button>
            <button className="tab" data-on={tab === "orders"} onClick={() => setTab("orders")}>
              Orders
              {order && <span className="tab-badge">1</span>}
            </button>
          </div>

          {/* Hidden rather than unmounted: switching to Orders mid-placement
              would otherwise throw away the card's approve/deposit progress and
              the lifecycle timeline with it. `contents` keeps both children as
              direct participants in the column's flex layout. */}
          <div style={{ display: tab === "swap" ? "contents" : "none" }}>
            <SwapCard
              session={session}
              refPrice={current?.refPrice ?? null}
              onActivity={() => setTick((t) => t + 1)}
              onConnect={requestConnect}
              connecting={connecting}
              market={market}
              onSelectMarket={selectMarket}
              batch={mine}
              currentBatch={current}
              liveOrder={order !== null}
              limits={limits}
              secondsLeft={secondsLeft(mine)}
              onWatchBatch={setWatchId}
              onViewOrder={() => setTab("orders")}
              /* Read straight from the chain rather than from the poll, because
                 the poll is stale for a beat after load and for up to an
                 interval after another tab acts. */
              verifyCanPlace={async () => {
                if (!session) return null;
                const id: bigint = await session.hashswap.currentBatchId();
                const b = await session.hashswap.getBatch(id);
                if (Number(b.status) !== 0) {
                  return "That batch just closed and is settling. The next one opens as soon as the keeper finishes.";
                }
                if ((await findIntent(session, id)) !== null) {
                  return "You already have an order in this batch. It has to clear before you can place another.";
                }
                return null;
              }}
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
              />
            )}
          </div>

          {tab === "orders" && (
            <OrdersPanel
              session={session}
              order={order}
              batch={current}
              limits={limits}
              secondsLeft={secondsLeft(current)}
              scanning={scanning}
              onActivity={() => setTick((t) => t + 1)}
              onGoToSwap={() => setTab("swap")}
              findIntent={findIntent}
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
