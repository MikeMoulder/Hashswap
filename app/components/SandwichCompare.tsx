"use client";

/// The side-by-side that makes the argument.
///
/// Figures are the real output of `scripts/demo/run-both.ts`, which runs both
/// lanes against the same pool state: a 10 BASE sell into a 1,000 BASE pool,
/// once in the open and once through HashSwap. Nothing here is illustrative.

const ROWS = [
  { label: "Fair value", naked: "19,743.16", hash: "19,743.16" },
  { label: "Actually received", naked: "14,953.76", hash: "19,900.32" },
];

function Step({
  n,
  title,
  detail,
  tone,
}: {
  n: string;
  title: string;
  detail: string;
  tone: "bad" | "good";
}) {
  return (
    <div className="flex gap-3.5 py-3" style={{ borderTop: "1px solid var(--line)" }}>
      <span
        className="mono text-[10px] pt-0.5 shrink-0"
        style={{ color: tone === "bad" ? "var(--red)" : "var(--faint)", width: 14 }}
      >
        {n}
      </span>
      <div>
        <p className="text-[13px] font-semibold">{title}</p>
        <p className="text-[12px] mt-0.5" style={{ color: "var(--faint)" }}>
          {detail}
        </p>
      </div>
    </div>
  );
}

export function SandwichCompare() {
  return (
    <section style={{ borderTop: "1px solid var(--line)" }}>
      <div className="max-w-6xl mx-auto px-6 py-24">
        <span className="eyebrow">The same trade, twice</span>
        <h2
          className="display-md mt-3"
          style={{ fontSize: "clamp(32px, 4.2vw, 46px)", maxWidth: 700 }}
        >
          Sell 10 in the open and you pay for the privilege
        </h2>
        <p className="mt-5 text-[15px] leading-relaxed" style={{ color: "var(--muted)", maxWidth: 520 }}>
          Both columns are the same order against the same pool, measured in our
          test harness. The only difference is whether anyone could see it coming.
        </p>

        <div className="grid md:grid-cols-2 gap-px mt-14" style={{ background: "var(--line)" }}>
          {/* ------------------------------------------------ naked */}
          <div className="p-8" style={{ background: "var(--ink)" }}>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold">Public swap</h3>
              <span className="tag">Visible in the mempool</span>
            </div>

            <div className="mt-6">
              <Step n="01" tone="bad" title="A bot sees your order" detail="Amount and direction are readable before it executes" />
              <Step n="02" tone="bad" title="It buys ahead of you" detail="Pushing the price against your trade" />
              <Step n="03" tone="bad" title="You fill at the worse price" detail="The gap between the two is their profit" />
            </div>

            <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--line)" }}>
              {ROWS.map((r) => (
                <div key={r.label} className="flex justify-between py-1.5 text-[13px]">
                  <span style={{ color: "var(--faint)" }}>{r.label}</span>
                  <span className="tnum">{r.naked}</span>
                </div>
              ))}
              <div className="flex justify-between items-baseline mt-5">
                <span className="eyebrow">Taken from you</span>
                <span className="display tnum" style={{ fontSize: 40, color: "var(--red)" }}>
                  4,789
                </span>
              </div>
            </div>
          </div>

          {/* --------------------------------------------- hashswap */}
          <div className="p-8" style={{ background: "var(--ink)" }}>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold">HashSwap</h3>
              <span className="tag tag-red">
                <span className="dot" /> Sealed
              </span>
            </div>

            <div className="mt-6">
              <Step n="01" tone="good" title="The bot sees 32 bytes" detail="No amount, no direction, nothing to price" />
              <Step n="02" tone="good" title="Your order is netted first" detail="16 of the 18 in the batch cancel out privately" />
              <Step n="03" tone="good" title="Only the remainder trades" detail="2 reaches the pool, and everyone clears at that price" />
            </div>

            <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--line)" }}>
              {ROWS.map((r) => (
                <div key={r.label} className="flex justify-between py-1.5 text-[13px]">
                  <span style={{ color: "var(--faint)" }}>{r.label}</span>
                  <span className="tnum">{r.hash}</span>
                </div>
              ))}
              <div className="flex justify-between items-baseline mt-5">
                <span className="eyebrow">Taken from you</span>
                <span className="display tnum" style={{ fontSize: 40 }}>
                  0
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className="text-[13px] mt-8" style={{ color: "var(--faint)" }}>
          Figures from <span className="mono">scripts/demo/run-both.ts</span> — a
          10 BASE sell into a 1,000 BASE pool, run both ways against identical
          state.
        </p>
      </div>
    </section>
  );
}
