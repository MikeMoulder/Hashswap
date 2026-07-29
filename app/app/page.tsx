"use client";

import Link from "next/link";
import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { NettingDiagram } from "@/components/NettingDiagram";
import { SandwichCompare } from "@/components/SandwichCompare";

const STEPS = [
  {
    n: "01",
    head: "Your order is sealed",
    body: "Size and direction are encrypted before they leave your browser. What reaches the network is a 32-byte reference — nothing a bot can read or price.",
  },
  {
    n: "02",
    head: "Orders cancel each other out",
    body: "Sealed orders are matched against one another first. A buyer and a seller of the same size settle between themselves and never touch the market.",
  },
  {
    n: "03",
    head: "Only the difference trades",
    body: "Whatever is left goes to Uniswap as a single trade, and everyone in the batch settles at that one price. No queue, no ordering advantage.",
  },
];

export default function Landing() {
  const { session, connect, connecting } = useSession();

  return (
    <main>
      <Nav session={session} onConnect={connect} connecting={connecting} />

      {/* ------------------------------------------------------------ hero */}
      <section className="relative">
        <div className="absolute inset-0 grid-bg pointer-events-none" />
        <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-28 grid lg:grid-cols-[1.05fr_0.95fr] gap-16 items-center">
          <div>
            <span className="tag tag-red">
              <span className="dot" /> Live on Sepolia
            </span>

            <h1 className="display mt-7" style={{ fontSize: "clamp(46px, 6.4vw, 76px)" }}>
              Trade without
              <br />
              <span style={{ color: "var(--red)" }}>tipping your hand</span>
            </h1>

            <p className="mt-7 text-[17px] leading-relaxed" style={{ color: "var(--muted)", maxWidth: 460 }}>
              On a public exchange everyone sees your order before it fills.
              HashSwap seals it, matches it against other orders privately, and
              sends only what is left to the market.
            </p>

            <div className="flex flex-wrap items-center gap-3 mt-9">
              <Link href="/swap" className="btn btn-red" style={{ width: "auto", padding: "15px 30px" }}>
                Start trading
              </Link>
              <Link href="#how" className="btn btn-line" style={{ padding: "15px 24px" }}>
                How it works
              </Link>
            </div>

            <dl className="mt-14 grid grid-cols-3 gap-8" style={{ maxWidth: 430 }}>
              {[
                ["89%", "never reaches the pool"],
                ["$0", "lost to front-running"],
                ["1", "price for everyone"],
              ].map(([stat, cap]) => (
                <div key={cap}>
                  <dt className="display" style={{ fontSize: 38, color: "var(--red)" }}>
                    {stat}
                  </dt>
                  <dd className="text-[12px] mt-2 leading-snug" style={{ color: "var(--faint)" }}>
                    {cap}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex justify-center lg:justify-end">
            <NettingDiagram />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- how */}
      <section id="how" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <span className="eyebrow">How it works</span>
          <h2 className="display-md mt-3" style={{ fontSize: "clamp(32px, 4.2vw, 46px)", maxWidth: 660 }}>
            Three steps, and the market only ever sees the last one
          </h2>

          <div className="grid md:grid-cols-3 gap-px mt-16" style={{ background: "var(--line)" }}>
            {STEPS.map((s) => (
              <div key={s.n} className="p-8" style={{ background: "var(--ink)" }}>
                <span className="display" style={{ fontSize: 42, color: "var(--red)" }}>
                  {s.n}
                </span>
                <h3 className="text-[17px] font-bold mt-5 tracking-tight">{s.head}</h3>
                <p className="text-[14px] mt-3 leading-relaxed" style={{ color: "var(--muted)" }}>
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <SandwichCompare />

      {/* --------------------------------------------------------- privacy */}
      <section id="private" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-16 items-start">
          <div>
            <span className="eyebrow">What stays private</span>
            <h2 className="display-md mt-3" style={{ fontSize: "clamp(32px, 4.2vw, 46px)" }}>
              One number becomes public.
              <br />
              <span style={{ color: "var(--faint)" }}>Never yours.</span>
            </h2>
            <p className="mt-7 text-[16px] leading-relaxed" style={{ color: "var(--muted)", maxWidth: 470 }}>
              Uniswap has to be given a plain number to trade, so every batch
              publishes exactly one: the difference left after orders have
              cancelled out. Your own order is never part of it.
            </p>
            <Link href="/swap" className="btn btn-line mt-9" style={{ padding: "14px 24px" }}>
              Verify it yourself
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-px" style={{ background: "var(--line)" }}>
            <div className="p-7" style={{ background: "var(--ink)" }}>
              <p className="eyebrow mb-5">Private</p>
              {["What you traded", "Which direction", "What you were filled", "Your balance"].map((x) => (
                <p key={x} className="py-2 text-[15px] font-medium" style={{ borderBottom: "1px solid var(--line)" }}>
                  {x}
                </p>
              ))}
            </div>
            <div className="p-7" style={{ background: "var(--ink)" }}>
              <p className="eyebrow mb-5">Public</p>
              {["The batch difference", "The clearing price", "That you took part", "Deposits"].map((x) => (
                <p
                  key={x}
                  className="py-2 text-[15px]"
                  style={{ color: "var(--faint)", borderBottom: "1px solid var(--line)" }}
                >
                  {x}
                </p>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24 text-center">
          <h2 className="display-md mx-auto" style={{ fontSize: "clamp(30px, 4vw, 44px)", maxWidth: 620 }}>
            Your next trade doesn&apos;t have to be public
          </h2>
          <Link
            href="/swap"
            className="btn btn-red mt-9"
            style={{ width: "auto", padding: "16px 36px", display: "inline-flex" }}
          >
            Start trading
          </Link>
        </div>
      </section>

      <Footer />
    </main>
  );
}
