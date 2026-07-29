"use client";

import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { Backdrop } from "@/components/Backdrop";

const TERMS = [
  {
    h: "Testnet software",
    p: "HashSwap runs on Ethereum Sepolia with test assets that carry no monetary value. It is unaudited hackathon software provided as-is, with no warranty of any kind.",
  },
  {
    h: "No custody promise",
    p: "Deposits sit in the HashSwap contract until you withdraw them. A batch that cannot settle can be cancelled after a timeout and refunds every participant, but no uptime or recovery guarantee is offered.",
  },
  {
    h: "What is public",
    p: "Each batch publishes exactly one number — the net residual and its direction — plus the clearing price. Participation is public: submitting an order is a transaction from your address. Deposits and withdrawals are public in amount.",
  },
  {
    h: "Market maker disclosure",
    p: "When a market maker fills a thin batch it can infer the position of the other participant by subtracting its own orders. Privacy holds against the public, not against the maker. This is disclosed rather than buried.",
  },
  {
    h: "Keeper trust",
    p: "The keeper cannot falsify a settlement — the residual is verified on-chain against a gateway signature before Uniswap is touched. It does choose when to submit, so transaction ordering is an economic rather than a cryptographic guarantee.",
  },
  {
    h: "No advice",
    p: "Nothing here is financial advice. You are responsible for the transactions you sign.",
  },
];

export default function Terms() {
  const { session, connect, connecting, error, disconnect } = useSession();

  return (
    <main className="min-h-screen flex flex-col relative">
      <Backdrop doodles={false} />
      <Nav
        session={session}
        onConnect={connect}
        connecting={connecting}
        error={error}
        onDisconnect={disconnect}
      />

      <div className="relative max-w-2xl mx-auto px-6 pt-16 pb-24 w-full">
        <span className="eyebrow">Terms</span>
        <h1 className="display mt-3" style={{ fontSize: "clamp(30px, 4.6vw, 42px)" }}>
          Terms of use
        </h1>

        <div className="mt-11 space-y-9">
          {TERMS.map((t) => (
            <section key={t.h}>
              <h2 className="text-[16px] font-semibold tracking-tight">{t.h}</h2>
              <p className="text-[14px] mt-2 leading-relaxed" style={{ color: "var(--muted)" }}>
                {t.p}
              </p>
            </section>
          ))}
        </div>
      </div>

      <Footer />
    </main>
  );
}
