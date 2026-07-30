"use client";

import Link from "next/link";
import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { NettingDiagram } from "@/components/NettingDiagram";
import { Backdrop } from "@/components/Backdrop";
import { SandwichCompare } from "@/components/SandwichCompare";
import { Reveal } from "@/components/Reveal";
import { CountUp } from "@/components/CountUp";

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

const STATS: Array<{ to: number; prefix?: string; suffix?: string; cap: string }> = [
  { to: 89, suffix: "%", cap: "never reaches the pool" },
  { to: 0, prefix: "$", cap: "lost to front-running" },
  { to: 1, cap: "price for everyone" },
];

const PRIVATE = ["What you traded", "Which direction", "What you were filled", "Your balance"];
const PUBLIC = ["The batch difference", "The clearing price", "That you took part", "Deposits"];

export default function Home() {
  const { session, connect, connecting, error, disconnect } = useSession();

  return (
    // `home` scopes the display face and the motion vocabulary to this page.
    <main className="home">
      <Nav
        session={session}
        onConnect={connect}
        connecting={connecting}
        error={error}
        onDisconnect={disconnect}
      />

      {/* ------------------------------------------------------------ hero

          Above the fold, so this animates on load rather than on scroll —
          an IntersectionObserver here would fire in the same frame anyway,
          and the staggered `--i` reads as the page assembling itself. */}
      <section className="relative">
        <Backdrop />
        <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-28 grid lg:grid-cols-[1.05fr_0.95fr] gap-16 items-center">
          <div>
            {/* The file is named for what it actually is: Nox publishes no mark
                of its own, and this is the iExec RLC logo its docs brand with.
                Left static — a third-party logo that pulses reads as broken,
                which the red dot it replaced did not. */}
            <span className="tag tag-red rise" style={{ "--i": 0 } as React.CSSProperties}>
              <img
                src="/iexec-rlc.png"
                alt=""
                width={12}
                height={12}
                style={{ display: "block", flexShrink: 0 }}
              />
              Powered by Nox
            </span>

            <h1
              className="display mt-7 rise"
              style={{ fontSize: "clamp(46px, 6.4vw, 76px)", "--i": 1 } as React.CSSProperties}
            >
              Trade without
              <br />
              <span className="wipe" style={{ color: "var(--red)" }}>
                tipping your hand
              </span>
            </h1>

            <p
              className="mt-7 text-[17px] leading-relaxed rise"
              style={{ color: "var(--muted)", maxWidth: 460, "--i": 2 } as React.CSSProperties}
            >
              On a public exchange everyone sees your order before it fills.
              HashSwap seals it, matches it against other orders privately, and
              sends only what is left to the market.
            </p>

            <div
              className="flex flex-wrap items-center gap-3 mt-9 rise"
              style={{ "--i": 3 } as React.CSSProperties}
            >
              <Link
                href="/"
                className="btn btn-red cta-pulse"
                style={{ width: "auto", padding: "15px 30px" }}
              >
                Start trading
              </Link>
              <Link href="#how" className="btn btn-line" style={{ padding: "15px 24px" }}>
                How it works
              </Link>
            </div>

            <dl className="mt-14 grid grid-cols-3 gap-8" style={{ maxWidth: 430 }}>
              {STATS.map((s, i) => (
                <div
                  key={s.cap}
                  className="rise"
                  style={{ "--i": 4 + i } as React.CSSProperties}
                >
                  <dt className="display" style={{ fontSize: 38, color: "var(--red)" }}>
                    <CountUp to={s.to} prefix={s.prefix} suffix={s.suffix} />
                  </dt>
                  <dd className="text-[12px] mt-2 leading-snug" style={{ color: "var(--faint)" }}>
                    {s.cap}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div
            className="flex justify-center lg:justify-end rise"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            <NettingDiagram />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- how */}
      <section id="how" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <Reveal>
            <span className="eyebrow">How it works</span>
            <span className="eyebrow-rule mt-3" />
            <h2
              className="display-md mt-5"
              style={{ fontSize: "clamp(32px, 4.2vw, 46px)", maxWidth: 660 }}
            >
              Three steps, and the market only ever sees the last one
            </h2>
          </Reveal>

          <div className="grid md:grid-cols-3 gap-px mt-16" style={{ background: "var(--line)" }}>
            {STEPS.map((s, i) => (
              // The Reveal wrapper becomes the grid item, so it and the card
              // both need full height or the gap-px hairlines break up.
              <Reveal key={s.n} delay={i * 110} className="h-full">
                <div className="card p-8 h-full">
                  <span className="display" style={{ fontSize: 42, color: "var(--red)" }}>
                    {s.n}
                  </span>
                  <h3 className="text-[17px] font-bold mt-5 tracking-tight">{s.head}</h3>
                  <p className="text-[14px] mt-3 leading-relaxed" style={{ color: "var(--muted)" }}>
                    {s.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <SandwichCompare />

      {/* --------------------------------------------------------- privacy */}
      <section id="private" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-16 items-start">
          <Reveal>
            <span className="eyebrow">What stays private</span>
            <span className="eyebrow-rule mt-3" />
            <h2 className="display-md mt-5" style={{ fontSize: "clamp(32px, 4.2vw, 46px)" }}>
              One number becomes public.
              <br />
              <span style={{ color: "var(--faint)" }}>Never yours.</span>
            </h2>
            <p className="mt-7 text-[16px] leading-relaxed" style={{ color: "var(--muted)", maxWidth: 470 }}>
              Uniswap has to be given a plain number to trade, so every batch
              publishes exactly one: the difference left after orders have
              cancelled out. Your own order is never part of it.
            </p>
            <Link href="/" className="btn btn-line mt-9" style={{ padding: "14px 24px" }}>
              Verify it yourself
            </Link>
          </Reveal>

          <Reveal delay={140}>
            <div className="grid grid-cols-2 gap-px" style={{ background: "var(--line)" }}>
              <div className="card p-7">
                <p className="eyebrow mb-5">Private</p>
                {PRIVATE.map((x) => (
                  <p
                    key={x}
                    className="py-2 text-[15px] font-medium"
                    style={{ borderBottom: "1px solid var(--line)" }}
                  >
                    {x}
                  </p>
                ))}
              </div>
              <div className="card p-7">
                <p className="eyebrow mb-5">Public</p>
                {PUBLIC.map((x) => (
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
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section style={{ borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-6 py-24 text-center">
          <Reveal>
            <h2
              className="display-md mx-auto"
              style={{ fontSize: "clamp(30px, 4vw, 44px)", maxWidth: 620 }}
            >
              Your next trade doesn&apos;t have to be public
            </h2>
            <Link
              href="/"
              className="btn btn-red mt-9 cta-pulse"
              style={{ width: "auto", padding: "16px 36px", display: "inline-flex" }}
            >
              Start trading
            </Link>
          </Reveal>
        </div>
      </section>

      <Footer />
    </main>
  );
}
