"use client";

import { short } from "@/lib/hashswap";
import { MARKETS, UNISWAP } from "@/lib/markets";

const EXPLORER = "https://sepolia.etherscan.io/address";

const COLUMNS: Array<{ head: string; items: Array<{ label: string; href?: string; value?: string }> }> = [
  {
    head: "Protocol",
    items: [
      // Both of these were bare fragments left over from the single-page
      // layout. `#verify` had no target at all and `#how` only resolves on
      // /home, so from the trade page they did nothing.
      { label: "How clearing works", href: "/home#how" },
      { label: "Test privacy", href: "/docs#verify" },
      { label: "Uniswap v3", href: "https://docs.uniswap.org" },
    ],
  },
  {
    head: "Built on",
    items: [
      { label: "Nox", href: "https://docs.noxprotocol.io" },
      { label: "iExec", href: "https://iex.ec" },
      { label: "Intel TDX", href: "https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html" },
    ],
  },
  {
    head: "Contracts",
    items: [
      ...MARKETS.map((m) => ({
        label: `${m.base.symbol}/${m.quote.symbol}`,
        href: `${EXPLORER}/${m.hashswap}`,
        value: short(m.hashswap, 6),
      })),
      { label: "Uniswap router", href: `${EXPLORER}/${UNISWAP.swapRouter02}`, value: short(UNISWAP.swapRouter02, 6) },
    ],
  },
];

export function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--line)" }} className="mt-28">
      <div className="max-w-6xl mx-auto px-6 py-14">
        <div className="grid gap-10 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div>
            <div className="flex items-center gap-2.5">
              <Mark />
              <span className="text-[15px] font-semibold tracking-tight">HashSwap</span>
            </div>
            <p className="text-[13px] mt-3 leading-relaxed" style={{ color: "var(--faint)", maxWidth: 260 }}>
              Private execution on public markets. Orders are sealed until they
              clear, and most never reach the order book at all.
            </p>
            <span className="tag mt-5">Sepolia testnet</span>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.head}>
              <p className="eyebrow mb-4">{col.head}</p>
              <ul className="space-y-2.5">
                {col.items.map((it) => (
                  <li key={it.label}>
                    <a
                      href={it.href}
                      target={it.href?.startsWith("http") ? "_blank" : undefined}
                      rel="noreferrer"
                      className="text-[13px] flex items-center justify-between gap-3 transition-colors"
                      style={{ color: "var(--muted)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--paper)")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
                    >
                      {it.label}
                      {it.value && (
                        <span className="mono text-[10px]" style={{ color: "var(--faint)" }}>
                          {it.value}
                        </span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <hr className="rule mt-12 mb-6" />

        <div className="flex flex-wrap items-center justify-between gap-4 text-[12px]" style={{ color: "var(--faint)" }}>
          <span>Testnet software. Not audited. Do not use with real funds.</span>
          <span>Uniswap is unmodified. HashSwap only calls it.</span>
        </div>
      </div>
    </footer>
  );
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <span
      className="grid place-items-center shrink-0"
      style={{ width: size, height: size, background: "var(--red)", borderRadius: 3 }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 16 16" fill="none">
        <path d="M6 2L4.5 14M11.5 2L10 14M2.5 5.5h12M1.5 10.5h12" stroke="#fff" strokeWidth="1.6" strokeLinecap="square" />
      </svg>
    </span>
  );
}
