"use client";

import { useState } from "react";
import { MARKETS, humanPrice, priceIsRealistic, type Market } from "@/lib/markets";
import { TokenPair } from "./TokenIcon";

/// Market selector.
///
/// Each market is a separate HashSwap deployment against a pre-existing Sepolia
/// Uniswap pool, so switching markets means switching contracts — not just a
/// display filter. Changing it drops the session and reconnects.

export function MarketPicker({
  market,
  onSelect,
  disabled,
}: {
  market: Market;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-2.5 px-3 py-2 w-full"
        style={{
          background: "var(--ink-2)",
          border: "1px solid var(--line)",
          borderRadius: 3,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <TokenPair base={market.base.symbol} quote={market.quote.symbol} size={22} />
        <span className="text-[14px] font-bold tracking-tight">
          {market.base.symbol} / {market.quote.symbol}
        </span>
        <span className="text-[11px] ml-auto" style={{ color: "var(--faint)" }}>
          {market.fee / 10000}%
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ color: "var(--faint)" }}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 right-0 mt-1 z-20 fade-up"
            style={{ background: "var(--ink-1)", border: "1px solid var(--line-2)", borderRadius: 3 }}
          >
            {MARKETS.map((m) => {
              const realistic = priceIsRealistic(m);
              return (
                <button
                  key={m.id}
                  className="flex items-center gap-2.5 px-3 py-2.5 w-full text-left"
                  style={{
                    borderBottom: "1px solid var(--line)",
                    background: m.id === market.id ? "var(--ink-2)" : "transparent",
                  }}
                  onClick={() => {
                    setOpen(false);
                    if (m.id !== market.id) onSelect(m.id);
                  }}
                >
                  <TokenPair base={m.base.symbol} quote={m.quote.symbol} size={22} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold">
                      {m.base.symbol} / {m.quote.symbol}
                    </p>
                    <p className="text-[11px] tnum" style={{ color: "var(--faint)" }}>
                      1 {m.base.symbol} ={" "}
                      {humanPrice(m).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                      {m.quote.symbol}
                    </p>
                  </div>
                  {!realistic && (
                    <span
                      className="text-[9px] ml-auto px-1.5 py-0.5 shrink-0"
                      style={{ border: "1px solid var(--line-2)", color: "var(--amber)", borderRadius: 2 }}
                      title="Testnet pools are seeded at arbitrary prices. The market works; the rate is not real-world."
                    >
                      ODD RATE
                    </span>
                  )}
                </button>
              );
            })}
            <p className="px-3 py-2 text-[11px]" style={{ color: "var(--faint)" }}>
              Live Uniswap v3 pools on Sepolia. We did not create them.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
