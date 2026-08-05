"use client";

/// The product in one picture: six sealed orders go in, they cancel against each
/// other, and a single small trade comes out. It replaces the swap card in the
/// hero now that trading lives on its own route — a marketing page should show
/// the idea, not bury a form above the fold.

const ORDERS = [
  { w: 88, side: "buy" },
  { w: 54, side: "sell" },
  { w: 72, side: "sell" },
  { w: 40, side: "buy" },
  { w: 64, side: "sell" },
  { w: 30, side: "buy" },
];

export function NettingDiagram() {
  return (
    <div className="surface p-8" style={{ width: "100%", maxWidth: 460 }}>
      <div className="flex items-center justify-between">
        <span className="eyebrow">Inside one batch</span>
        <span className="tag">
          <span className="dot" /> Sealed
        </span>
      </div>

      {/* Incoming orders — deliberately unlabelled. Nobody can read these.
          They draw in one after another so the batch reads as filling up. */}
      <div className="mt-7 space-y-2.5">
        {ORDERS.map((o, i) => (
          <div key={i} className="flex items-center gap-3">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ color: "var(--faint)" }}>
              <rect x="4.5" y="10.5" width="15" height="9" stroke="currentColor" strokeWidth="2" />
              <path d="M8 10.5V7a4 4 0 018 0v3.5" stroke="currentColor" strokeWidth="2" />
            </svg>
            <div
              className="netbar"
              style={
                {
                  width: `${o.w}%`,
                  height: 12,
                  background: "var(--ink-3)",
                  borderLeft: "2px solid var(--faint)",
                  "--i": i,
                } as React.CSSProperties
              }
            />
          </div>
        ))}
      </div>

      <p className="text-[12px] mt-4" style={{ color: "var(--faint)" }}>
        Six orders. No sizes, no sides. Not to us, not to anyone watching.
      </p>

      <div className="flex items-center gap-3 my-7">
        <hr className="rule flex-1" />
        <span className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--faint)" }}>
          they cancel out
        </span>
        <hr className="rule flex-1" />
      </div>

      {/* What survives — held back until the six above have finished, so the
          sequence reads as cause and effect rather than one group appearing. */}
      <div className="flex items-center gap-3">
        <div className="netbar netbar-out" style={{ width: "11%", height: 22, background: "var(--red)" }} />
        <div className="flex-1">
          <p className="text-[13px] font-bold">One trade reaches the market</p>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--faint)" }}>
            89% of the volume never appears
          </p>
        </div>
      </div>
    </div>
  );
}
