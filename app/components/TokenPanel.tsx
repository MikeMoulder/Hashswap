"use client";

import { fmt } from "@/lib/hashswap";

export type Token = { symbol: string; name: string };

export const TOKENS: Record<"BASE" | "QUOTE", Token> = {
  BASE: { symbol: "hBASE", name: "Base asset" },
  QUOTE: { symbol: "hQUOTE", name: "Quote asset" },
};

/// One side of the trade. The `sealed` variant replaces the amount with a
/// statement rather than a number, because with batch clearing the received
/// amount genuinely does not exist yet — inventing a figure there would be the
/// one dishonest element on the page.
export function TokenPanel({
  label,
  token,
  value,
  onChange,
  balance,
  sealed,
  busy,
}: {
  label: string;
  token: Token;
  value?: string;
  onChange?: (v: string) => void;
  balance?: bigint | null;
  sealed?: boolean;
  busy?: boolean;
}) {
  return (
    <div className={`field p-4 ${busy ? "scanning" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="eyebrow">{label}</span>
        {balance !== undefined && (
          <span className="text-[12px] tnum" style={{ color: "var(--faint)" }}>
            {balance === null ? (
              "—"
            ) : (
              <>
                <span style={{ color: "var(--muted)" }}>{fmt(balance, 4)}</span>
                {onChange && balance > 0n && (
                  <button
                    className="btn btn-quiet ml-3"
                    onClick={() => onChange(fmt(balance, 6).replace(/,/g, ""))}
                  >
                    MAX
                  </button>
                )}
              </>
            )}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {sealed ? (
          <div className="flex items-center gap-2.5" style={{ height: 40, flex: 1 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ color: "var(--red)" }}>
              <rect x="4.5" y="10.5" width="15" height="9" stroke="currentColor" strokeWidth="1.7" />
              <path d="M8 10.5V7a4 4 0 018 0v3.5" stroke="currentColor" strokeWidth="1.7" />
            </svg>
            <span className="text-[17px]" style={{ color: "var(--muted)" }}>
              Priced at settlement
            </span>
          </div>
        ) : (
          <input
            className="amount"
            inputMode="decimal"
            placeholder="0.00"
            value={value ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) onChange?.(v);
            }}
          />
        )}

        <div className="ticker shrink-0">{token.symbol}</div>
      </div>
    </div>
  );
}
