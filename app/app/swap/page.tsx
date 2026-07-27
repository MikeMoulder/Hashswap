"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { SwapCard } from "@/components/SwapCard";
import { BatchStrip } from "@/components/BatchStrip";
import { PrivacyProof } from "@/components/PrivacyProof";

/// The application. Separate from the marketing page so the trading surface
/// opens directly, with no scrolling past a pitch to reach it.
export default function SwapPage() {
  const { session, connect, connecting, error } = useSession();
  const [tick, setTick] = useState(0);
  const [refPrice, setRefPrice] = useState<bigint | null>(null);

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

      <div className="flex-1">
        <div className="max-w-6xl mx-auto px-6 py-14 grid lg:grid-cols-[440px_1fr] gap-14 items-start justify-center">
          {/* trading column */}
          <div className="flex flex-col items-center lg:items-start w-full">
            {error && (
              <div
                className="surface px-4 py-3 mb-3 text-[12px] mono"
                style={{ width: "100%", maxWidth: 440, color: "var(--red)" }}
              >
                {error}
              </div>
            )}

            {!session && (
              <div className="surface px-5 py-4 mb-3" style={{ width: "100%", maxWidth: 440 }}>
                <p className="text-[13px]" style={{ color: "var(--muted)" }}>
                  Connect a wallet on Sepolia to place a private order.
                </p>
                <button className="btn btn-line w-full mt-3" onClick={connect} disabled={connecting}>
                  {connecting ? "Connecting…" : "Connect wallet"}
                </button>
              </div>
            )}

            <SwapCard session={session} refPrice={refPrice} onActivity={() => setTick((t) => t + 1)} />
            <BatchStrip session={session} tick={tick} />
          </div>

          {/* context column */}
          <div className="space-y-5">
            <div className="surface p-7">
              <span className="eyebrow">Why this is different</span>
              <h2 className="display-md mt-3" style={{ fontSize: 26 }}>
                Your order joins a batch, it doesn&apos;t hit the book
              </h2>
              <p className="text-[14px] mt-4 leading-relaxed" style={{ color: "var(--muted)" }}>
                Orders collect for a short window, cancel against each other, and
                settle together at one price. Because your size and direction stay
                sealed the whole time, there is nothing for anyone to trade ahead
                of — and most of the volume never reaches the market at all.
              </p>

              <div className="grid grid-cols-3 gap-6 mt-7">
                {[
                  ["Sealed", "until settlement"],
                  ["Netted", "against other orders"],
                  ["Uniform", "one price per batch"],
                ].map(([a, b]) => (
                  <div key={a}>
                    <p className="text-[15px] font-bold">{a}</p>
                    <p className="text-[12px] mt-1" style={{ color: "var(--faint)" }}>
                      {b}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <PrivacyProof session={session} />
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
