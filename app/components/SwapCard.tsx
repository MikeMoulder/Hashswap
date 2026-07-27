"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { CONTRACTS, fmt, tryDecrypt, type Session } from "@/lib/hashswap";
import { TokenPanel, TOKENS } from "./TokenPanel";

type Stage = "idle" | "depositing" | "encrypting" | "submitting" | "submitted";

const ONE = 10n ** 18n;

export function SwapCard({
  session,
  onActivity,
  refPrice,
}: {
  session: Session | null;
  onActivity: () => void;
  refPrice: bigint | null;
}) {
  const [sellBase, setSellBase] = useState(true);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [sealed, setSealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseBal, setBaseBal] = useState<bigint | null>(null);
  const [quoteBal, setQuoteBal] = useState<bigint | null>(null);

  const sellToken = sellBase ? TOKENS.BASE : TOKENS.QUOTE;
  const buyToken = sellBase ? TOKENS.QUOTE : TOKENS.BASE;

  useEffect(() => {
    if (!session) return;
    let dead = false;
    (async () => {
      try {
        const [b, q] = await Promise.all([
          session.hashswap.balanceHandleOf(CONTRACTS.base, session.address),
          session.hashswap.balanceHandleOf(CONTRACTS.quote, session.address),
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
      return amount ? ethers.parseUnits(amount, 18) : 0n;
    } catch {
      return 0n;
    }
  })();

  const sellBal = sellBase ? baseBal : quoteBal;
  const short = sellBal !== null && parsed > sellBal;

  async function deposit() {
    if (!session || parsed === 0n) return;
    setStage("depositing");
    setError(null);
    try {
      const token = sellBase ? session.base : session.quote;
      const addr = sellBase ? CONTRACTS.base : CONTRACTS.quote;
      await (await token.mint(session.address, parsed)).wait();
      await (await token.approve(CONTRACTS.hashswap, parsed)).wait();
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

      const amt = await session.handleClient.encryptInput(baseAmount, "uint256", CONTRACTS.hashswap);
      const side = await session.handleClient.encryptInput(isBuy, "bool", CONTRACTS.hashswap);
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

  const label = !session
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
      <div className="flex">
        <button className="tab" data-active={sellBase} onClick={() => { setSellBase(true); setAmount(""); }}>
          Sell
        </button>
        <button className="tab" data-active={!sellBase} onClick={() => { setSellBase(false); setAmount(""); }}>
          Buy
        </button>
      </div>

      <div className="p-5">
        <div className="space-y-2">
          <TokenPanel
            label="You pay"
            token={sellToken}
            value={amount}
            onChange={setAmount}
            balance={sellBal}
            busy={stage === "encrypting"}
          />
          <TokenPanel label="You receive" token={buyToken} sealed balance={sellBase ? quoteBal : baseBal} />
        </div>

        <div className="mt-5 space-y-2.5 text-[13px]">
          <Row
            label="Market reference"
            value={refPrice ? `${fmt(refPrice, 2)} ${TOKENS.QUOTE.symbol}` : "—"}
          />
          <Row label="Execution" value="Uniform batch price" />
          <Row
            label="Front-running risk"
            value={<span style={{ color: "var(--red)" }}>None</span>}
          />
        </div>

        {short && parsed > 0n && (
          <button className="btn btn-line w-full mt-5" disabled={busy} onClick={deposit}>
            {stage === "depositing" ? "Depositing…" : `Deposit ${amount} ${sellToken.symbol}`}
          </button>
        )}

        <button
          className="btn btn-red mt-3"
          disabled={!session || parsed === 0n || short || busy}
          onClick={submit}
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
