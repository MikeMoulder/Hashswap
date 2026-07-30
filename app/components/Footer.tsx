"use client";

const COLUMNS: Array<{ head: string; items: Array<{ label: string; href: string }> }> = [
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
    head: "Resources",
    items: [
      { label: "Documentation", href: "/docs" },
      { label: "Source code", href: "https://github.com/MikeMoulder/Hashswap" },
      { label: "Terms of use", href: "/terms" },
    ],
  },
];

/// Two blocks, not four columns.
///
/// The previous grid spread brand + three link columns evenly across the full
/// 1152px, which left every column orphaned in its own field of whitespace.
/// Holding the links together as one cluster opposite the brand gives the row
/// two things to read instead of four, and the gaps land between groups rather
/// than inside them.
export function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--line)" }} className="mt-24">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:justify-between">
          <div style={{ maxWidth: 272 }}>
            {/* Same lockup as the nav, one size up. */}
            <div className="flex items-center gap-2.5">
              <img
                src="/logo.png"
                alt=""
                width={13}
                height={34}
                className="logo-float"
                style={{ display: "block" }}
              />
              <span className="text-[15px] font-semibold tracking-tight">HashSwap</span>
            </div>
            <p className="text-[13px] mt-2.5 leading-relaxed" style={{ color: "var(--faint)" }}>
              Private execution on public markets. Orders are sealed until they
              clear, and most never reach the order book at all.
            </p>
          </div>

          <nav className="grid grid-cols-2 gap-x-12 gap-y-9 sm:grid-cols-3 sm:gap-x-16">
            {COLUMNS.map((col) => (
              <div key={col.head}>
                <p className="eyebrow mb-3.5">{col.head}</p>
                <ul className="space-y-2">
                  {col.items.map((it) => (
                    <li key={it.label}>
                      <a
                        href={it.href}
                        target={it.href.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                        className="text-[13px] transition-colors"
                        style={{ color: "var(--muted)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--paper)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
                      >
                        {it.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
