"use client";

import Link from "next/link";
import { useSession } from "@/lib/useSession";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { Backdrop } from "@/components/Backdrop";
import { PrivacyProof } from "@/components/PrivacyProof";
import { MARKETS, UNISWAP } from "@/lib/markets";

const EXPLORER = "https://sepolia.etherscan.io/address";

const SECTIONS = [
  {
    h: "Sealing an order",
    p: "Amount and direction are encrypted at the Nox gateway before the transaction is built. What reaches the chain is a 32-byte handle and a proof — the calldata contains no number a bot could read.",
  },
  {
    h: "Netting",
    p: "Orders accumulate into encrypted running totals. At close the contract computes crossed = min(buys, sells) and residual = |buys − sells| entirely over ciphertext, using branchless Solidity — no conditional ever sees a plaintext value.",
  },
  {
    h: "Settlement",
    p: "Only the residual is decrypted. A keeper fetches it with a gateway signature, and settle() verifies that signature on-chain before touching Uniswap. A keeper reporting a false residual reverts.",
  },
  {
    h: "Clearing price",
    p: "The residual executes as one swap. Whatever price it gets becomes the price for everyone in the batch — no ordering advantage, no queue position worth paying for.",
  },
];

const LIMITS = [
  ["Privacy scales with participation.", "A batch needs three orders before it can settle, because with one the residual would be that order."],
  ["Uniform pricing is fair, not free.", "In a one-sided batch a small trader pays the aggregate's average price."],
  ["The maker sees what it fills.", "When the market maker pads a thin batch it can infer the other side. The public still cannot."],
  ["Testnet pools are priced arbitrarily.", "Markets flagged ODD RATE work correctly but do not reflect real-world rates."],
];

export default function Docs() {
  const { session, connect, connecting, error, disconnect } = useSession();

  return (
    <main className="min-h-screen flex flex-col relative">
      <Backdrop />
      <Nav
        session={session}
        onConnect={connect}
        connecting={connecting}
        error={error}
        onDisconnect={disconnect}
      />

      <div className="relative max-w-3xl mx-auto px-6 pt-16 pb-24 w-full">
        <span className="eyebrow">Docs</span>
        <h1 className="display mt-3" style={{ fontSize: "clamp(32px, 5vw, 46px)" }}>
          How HashSwap works
        </h1>
        <p
          className="mt-5 text-[16px] leading-relaxed"
          style={{ color: "var(--muted)", maxWidth: 560 }}
        >
          A confidential batch-netting layer over unmodified Uniswap v3 pools. For the
          narrative version, see{" "}
          <Link href="/home" style={{ color: "var(--red)" }}>
            how it works
          </Link>
          .
        </p>

        <div className="mt-12 space-y-px" style={{ background: "var(--line)" }}>
          {SECTIONS.map((s, i) => (
            <div key={s.h} className="py-7" style={{ background: "var(--ink)" }}>
              <div className="flex gap-5">
                <span className="mono text-[12px] pt-1" style={{ color: "var(--red)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h2 className="text-[17px] font-semibold tracking-tight">{s.h}</h2>
                  <p
                    className="text-[14px] mt-2 leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    {s.p}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <h2 className="display-md mt-16 text-[24px]">Deployed contracts</h2>
        <p className="text-[13px] mt-2" style={{ color: "var(--faint)" }}>
          Sepolia. Each market is its own instance — base, quote and fee are immutable.
        </p>

        <div className="glass mt-6 p-5 space-y-3">
          {MARKETS.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-4 text-[13px]">
              <span className="font-medium">
                {m.base.symbol} / {m.quote.symbol}
              </span>
              <a
                className="mono text-[12px]"
                style={{ color: "var(--muted)" }}
                href={`${EXPLORER}/${m.hashswap}`}
                target="_blank"
                rel="noreferrer"
              >
                {m.hashswap.slice(0, 10)}…{m.hashswap.slice(-4)}
              </a>
            </div>
          ))}
          <hr className="rule" />
          <div className="flex items-center justify-between gap-4 text-[13px]">
            <span style={{ color: "var(--muted)" }}>Uniswap SwapRouter02</span>
            <a
              className="mono text-[12px]"
              style={{ color: "var(--muted)" }}
              href={`${EXPLORER}/${UNISWAP.swapRouter02}`}
              target="_blank"
              rel="noreferrer"
            >
              {UNISWAP.swapRouter02.slice(0, 10)}…{UNISWAP.swapRouter02.slice(-4)}
            </a>
          </div>
        </div>

        {/* Moved here from the trade page. It is a claim to be checked, not a
            step in placing an order, and sitting under the swap card it read as
            something you had to do before trading. */}
        <h2 id="verify" className="display-md mt-16 text-[24px]" style={{ scrollMarginTop: 90 }}>
          Check it yourself
        </h2>
        <p className="text-[13px] mt-2 leading-relaxed" style={{ color: "var(--faint)", maxWidth: 560 }}>
          The confidentiality claim is the one worth testing rather than reading.
          Connect a wallet, read your own balance, then try to read a real
          trader&apos;s and watch the gateway refuse.
        </p>
        <div className="mt-6">
          <PrivacyProof session={session} />
        </div>

        <h2 className="display-md mt-16 text-[24px]">Limits worth knowing</h2>
        <ul className="mt-5 space-y-3 text-[14px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {LIMITS.map(([bold, rest]) => (
            <li key={bold}>
              <strong style={{ color: "var(--paper)" }}>{bold}</strong> {rest}
            </li>
          ))}
        </ul>
      </div>

      <Footer />
    </main>
  );
}
