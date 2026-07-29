"use client";

import { formatUnits, type Token } from "@/lib/markets";

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
  estimate,
  busy,
}: {
  label: string;
  token: Token;
  value?: string;
  onChange?: (v: string) => void;
  balance?: bigint | null;
  sealed?: boolean;
  estimate?: bigint | null;
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
                <span style={{ color: "var(--muted)" }}>{formatUnits(balance, token.decimals, 4)}</span>
                {onChange && balance > 0n && (
                  <button
                    className="btn btn-quiet ml-3"
                    onClick={() => onChange(formatUnits(balance, token.decimals, 6).replace(/,/g, ""))}
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
          /* An estimate, clearly marked as one. Refusing to show any number at
             all was over-cautious: the reference price is public and we can
             price the trade as accurately as Uniswap does. What we genuinely
             cannot know in advance is the batch clearing price, so the figure
             is prefixed with ≈ and the details row says where the real one
             comes from. */
          <div className="flex items-center gap-2.5" style={{ height: 40, flex: 1 }}>
            {estimate != null && estimate > 0n ? (
              <span className="amount" style={{ color: "var(--muted)" }}>
                ≈ {formatUnits(estimate, token.decimals, 4)}
              </span>
            ) : (
              <span className="text-[17px]" style={{ color: "var(--faint)" }}>
                0.00
              </span>
            )}
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
