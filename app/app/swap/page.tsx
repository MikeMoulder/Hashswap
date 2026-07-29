"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { SwapCard } from "@/components/SwapCard";
import { BatchStrip } from "@/components/BatchStrip";
import { PrivacyProof } from "@/components/PrivacyProof";

/// The application. A single centred column: trade panel, live batch, and the
/// privacy check tucked underneath. Explanation lives on the marketing page —
/// once someone is here they came to trade, not to read.
export default function SwapPage() {
  const { session, connect, connecting, error, market, selectMarket } = useSession();
  const [tick, setTick] = useState(0);
  const [refPrice, setRefPrice] = useState<bigint | null>(null);
  const [showVerify, setShowVerify] = useState(false);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const id = await session.hashswap.currentBatchId();
        setRefPrice((await session.hashswap.getBatch(id)).refPrice);
      } catch {
        /* ignore */
      }
    })();
  }, [session, tick]);

  return (
    <main className="min-h-screen flex flex-col">
      <Nav session={session} onConnect={connect} connecting={connecting} />

      <div className="flex-1 flex justify-center px-6 py-16">
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
            refPrice={refPrice}
            onActivity={() => setTick((t) => t + 1)}
            onConnect={connect}
            connecting={connecting}
            market={market}
            onSelectMarket={selectMarket}
          />

          <BatchStrip session={session} tick={tick} />

          <button
            className="text-[12px] mt-6 transition-colors"
            style={{ color: "var(--faint)" }}
            onClick={() => setShowVerify((v) => !v)}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--muted)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--faint)")}
          >
            {showVerify ? "Hide privacy check" : "Check the privacy yourself"}
          </button>

          {showVerify && (
            <div className="w-full mt-4 fade-up">
              <PrivacyProof session={session} />
            </div>
          )}
        </div>
      </div>

      <Footer />
    </main>
  );
}
