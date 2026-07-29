"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { tryDecrypt, type Session } from "@/lib/hashswap";
import { formatUnits, parseUnits, humanPrice, getMarket, type Market } from "@/lib/markets";
import { TokenPanel } from "./TokenPanel";
import { MarketPicker } from "./MarketPicker";

type Stage = "idle" | "depositing" | "encrypting" | "submitting" | "submitted";

const ONE = 10n ** 18n;

export function SwapCard({
  session,
  onActivity,
  refPrice,
  onConnect,
  connecting,
  market,
  onSelectMarket,
}: {
  session: Session | null;
  onActivity: () => void;
  refPrice: bigint | null;
  onConnect?: () => void;
  connecting?: boolean;
  market: Market;
  onSelectMarket: (id: string) => void;
}) {
  const [sellBase, setSellBase] = useState(true);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [sealed, setSealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseBal, setBaseBal] = useState<bigint | null>(null);
  const [quoteBal, setQuoteBal] = useState<bigint | null>(null);

  const sellToken = sellBase ? market.base : market.quote;
  const buyToken = sellBase ? market.quote : market.base;

  useEffect(() => {
    if (!session) return;
    let dead = false;
    (async () => {
      try {
        const [b, q] = await Promise.all([
          session.hashswap.balanceHandleOf(market.base.address, session.address),
          session.hashswap.balanceHandleOf(market.quote.address, session.address),
        ]);
        const [bv, qv] = await Promise.all([
          tryDecrypt(session.handleClient, b),
          tryDecrypt(session.handleClient, q),
        ]);
        if (dead) return;
        setBaseBal(bv?.value ?? null);
        setQuoteBal(qv?.value ?? null);
      } catch {
        /* leave unknown */
      }
    })();
    return () => {
      dead = true;
    };
  }, [session, stage]);

  const parsed = (() => {
    try {
      return amount ? parseUnits(amount, sellToken.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();

  const sellBal = sellBase ? baseBal : quoteBal;
  const short = sellBal !== null && parsed > sellBal;

  // Live estimate from Uniswap's QuoterV2, debounced so typing does not spam
  // the RPC. This is what the trade would fetch executed alone right now; the
  // batch clearing price is normally better, because netted volume pays neither
  // slippage nor the LP fee.
  //
  // `staticCall` is required: QuoterV2 simulates the swap and returns its answer
  // by reverting with it, so a normal call would cost gas and throw.
  const [estimate, setEstimate] = useState<bigint | null>(null);
  useEffect(() => {
    if (!session || parsed === 0n) {
      setEstimate(null);
      return;
    }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const [amountOut] = await session.quoter.quoteExactInputSingle.staticCall({
          tokenIn: sellBase ? market.base.address : market.quote.address,
          tokenOut: sellBase ? market.quote.address : market.base.address,
          amountIn: parsed,
          fee: market.fee,
          sqrtPriceLimitX96: 0n,
        });
        if (!dead) setEstimate(amountOut as bigint);
      } catch {
        // Pool unreachable or the amount exceeds available liquidity — fall back
        // to the reference price so the field is never blank.
        if (!dead && refPrice) {
          setEstimate(sellBase ? (parsed * refPrice) / ONE : (parsed * ONE) / refPrice);
        }
      }
    }, 280);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [session, parsed, sellBase, refPrice]);

  async function deposit() {
    if (!session || parsed === 0n) return;
    setStage("depositing");
    setError(null);
    try {
      const token = sellBase ? session.base : session.quote;
      const addr = sellBase ? market.base.address : market.quote.address;

      // These are real Sepolia tokens — there is no mint to fall back on, so a
      // short wallet balance has to be surfaced rather than papered over.
      const held: bigint = await token.balanceOf(session.address);
      if (held < parsed) {
        throw new Error(
          `You hold ${formatUnits(held, sellToken.decimals, 4)} ${sellToken.symbol} — acquire more before depositing.`,
        );
      }

      await (await token.approve(market.hashswap, parsed)).wait();
      await (await session.hashswap.deposit(addr, parsed)).wait();
      setStage("idle");
      onActivity();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
      setStage("idle");
    }
  }

  async function submit() {
    if (!session || parsed === 0n) return;
    setError(null);
    setSealed(false);
    try {
      setStage("encrypting");
      const isBuy = !sellBase;
      const baseAmount = isBuy && refPrice ? (parsed * ONE) / refPrice : parsed;

      const amt = await session.handleClient.encryptInput(baseAmount, "uint256", market.hashswap);
      const side = await session.handleClient.encryptInput(isBuy, "bool", market.hashswap);
      setSealed(true);

      setStage("submitting");
      await (
        await session.hashswap.submitIntent(amt.handle, amt.handleProof, side.handle, side.handleProof)
      ).wait();

      setStage("submitted");
      setAmount("");
      onActivity();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "submitted";

  const label = connecting
    ? "Connecting…"
    : !session
    ? "Connect wallet"
    : parsed === 0n
      ? "Enter an amount"
      : short
        ? "Insufficient balance"
        : stage === "encrypting"
          ? "Sealing order"
          : stage === "submitting"
            ? "Submitting"
            : "Place private order";

  return (
    <div className="surface" style={{ width: "100%", maxWidth: 440 }}>
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="text-[16px] font-bold tracking-tight">Swap</h2>
        <span className="tag">
          <span className="dot" /> Private
        </span>
      </div>

      <div className="p-5">
        <div className="mb-3">
          <MarketPicker market={market} onSelect={onSelectMarket} disabled={busy} />
        </div>

        {/* One asset in, another out, with a flip between them — the AMM idiom.
            There is no order book here to buy or sell into, so buy/sell tabs
            were describing the contract's internal side flag rather than
            anything the trader does. */}
        <div className="relative">
          <TokenPanel
            label="You pay"
            token={sellToken}
            value={amount}
            onChange={setAmount}
            balance={sellBal}
            busy={stage === "encrypting"}
          />

          <div className="relative" style={{ height: 6 }}>
            <button
              className="flip"
              aria-label="Switch direction"
              onClick={() => {
                setSellBase((s) => !s);
                setAmount("");
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 4.5v14M7 18.5l-3.5-3.5M17 19.5v-14M17 5.5l3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <TokenPanel
            label="You receive"
            token={buyToken}
            sealed
            estimate={estimate}
            balance={sellBase ? quoteBal : baseBal}
          />
        </div>

        <div className="mt-5 space-y-2.5 text-[13px]">
          <Row
            label="Estimated"
            value={
              estimate ? (
                <>
                  {formatUnits(estimate, buyToken.decimals, 4)} {buyToken.symbol}
                </>
              ) : (
                "—"
              )
            }
          />
          <Row label="Final price" value="set when the batch clears" />
          <Row label="Settles in" value="~90 seconds" />
          <Row label="Front-running risk" value={<span style={{ color: "var(--red)" }}>None</span>} />
        </div>

        {short && parsed > 0n && (
          <button className="btn btn-line w-full mt-5" disabled={busy} onClick={deposit}>
            {stage === "depositing" ? "Depositing…" : `Deposit ${amount} ${sellToken.symbol}`}
          </button>
        )}

        {/* One button, three jobs — connect, then deposit if short, then trade.
            Disabling it while disconnected would strand the user with no
            obvious next step, which is why the card owns connection too. */}
        <button
          className="btn btn-red mt-3"
          disabled={session ? parsed === 0n || short || busy : connecting}
          onClick={session ? submit : onConnect}
        >
          {label}
        </button>

        {sealed && stage !== "idle" && (
          <p className="fade-up text-[12px] mt-4 text-center" style={{ color: "var(--muted)" }}>
            Order sealed. The network sees a 32-byte reference — no amount, no side.
          </p>
        )}

        {stage === "submitted" && (
          <p className="fade-up text-[13px] mt-4 text-center" style={{ color: "var(--green)" }}>
            Order placed. It clears when the batch closes.
          </p>
        )}

        {error && (
          <p className="text-[12px] mono mt-4" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span style={{ color: "var(--faint)" }}>{label}</span>
      <span className="tnum">{value}</span>
    </div>
  );
}
