"use client";

import { useState } from "react";
import { fmt, short, tryDecrypt, type Session } from "@/lib/hashswap";
import { formatUnits } from "@/lib/markets";

type Row = { label: string; handle: string; value: bigint | null };

/// Privacy you can check rather than take on trust: read your own balance, then
/// try to read someone else's and watch it refuse.
export function PrivacyProof({ session }: { session: Session | null }) {
  const [mine, setMine] = useState<Row[] | null>(null);
  const [theirs, setTheirs] = useState<Row[] | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<"mine" | "theirs" | null>(null);

  async function read(who: string): Promise<Row[]> {
    const out: Row[] = [];
    for (const [label, token] of [
      [session!.market.base.symbol, session!.market.base.address],
      [session!.market.quote.symbol, session!.market.quote.address],
    ] as const) {
      const handle: string = await session!.hashswap.balanceHandleOf(token, who);
      const res = await tryDecrypt(session!.handleClient, handle);
      out.push({ label, handle, value: res ? res.value : null });
    }
    return out;
  }

  return (
    <div className="surface p-6">
      <span className="eyebrow">Verify</span>
      <h3 className="display mt-2" style={{ fontSize: 26 }}>
        Don&apos;t take our word for it
      </h3>
      <p className="text-[14px] mt-2.5 leading-relaxed" style={{ color: "var(--muted)" }}>
        Every balance is stored as a reference, not a number. Read yours below,
        then try to read anyone else&apos;s.
      </p>

      <button
        className="btn btn-line w-full mt-5"
        disabled={!session || busy !== null}
        onClick={async () => {
          setBusy("mine");
          try {
            setMine(await read(session!.address));
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "mine" ? "Reading…" : "Read my balance"}
      </button>
      {mine && <Result rows={mine} />}

      <hr className="rule my-6" />

      <p className="text-[13px] font-semibold">Someone else&apos;s</p>
      <input
        value={addr}
        onChange={(e) => setAddr(e.target.value.trim())}
        placeholder="0x…"
        className="field mono w-full mt-3 px-3 py-2.5 text-[12px]"
        style={{ color: "var(--paper)", outline: "none" }}
      />
      <button
        className="btn btn-line w-full mt-2"
        disabled={!session || !addr || busy !== null}
        onClick={async () => {
          setBusy("theirs");
          try {
            setTheirs(await read(addr));
          } catch {
            setTheirs(null);
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "theirs" ? "Trying…" : "Try to read it"}
      </button>

      {theirs && (
        <>
          <Result rows={theirs} />
          {theirs.every((r) => r.value === null) && (
            <p className="fade-up text-[13px] mt-4 leading-relaxed" style={{ color: "var(--muted)" }}>
              <span style={{ color: "var(--red)" }}>Refused.</span> The reference
              is public and anyone can see it on-chain. The balance behind it
              belongs to its owner alone.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Result({ rows }: { rows: Row[] }) {
  return (
    <div className="fade-up mt-4 space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 text-[13px]">
          <span style={{ color: "var(--faint)" }}>{r.label}</span>
          <span className="mono text-[10px]" style={{ color: "var(--faint)" }}>
            {short(r.handle, 6)}
          </span>
          <span className="tnum text-right" style={{ minWidth: 88 }}>
            {r.value === null ? (
              <span style={{ color: "var(--red)" }}>Refused</span>
            ) : (
              fmt(r.value, 4)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
