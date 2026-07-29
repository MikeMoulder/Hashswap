"use client";

import { formatUnits, type Token } from "@/lib/markets";
import { TokenIcon } from "./TokenIcon";

/// The encrypted vault balance, and why it is or is not a number right now.
///
/// It used to be `bigint | null`, which forced four different situations through
/// one value: still loading, refused by the enclave, declined at the wallet, and
/// gateway down. All four drew the same redacted block, so a balance that had
/// simply not arrived yet was indistinguishable from one being withheld, and
/// neither offered a way forward.
export type VaultBalance =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: bigint }
  | { kind: "locked"; reason: string }
  | { kind: "denied"; reason: string }
  | { kind: "error"; reason: string };

/// One side of the trade.
///
/// Two balances, because there are genuinely two. Tokens in the wallet are
/// public and read straight from the ERC-20; tokens in the vault are encrypted
/// and need a signature to read. Showing only the second is what made the panel
/// look broken to anyone who had not deposited yet: their wallet was full and
/// the app said nothing at all.
export function TokenPanel({
  label,
  token,
  value,
  onChange,
  wallet,
  vault,
  onUnlock,
  sealed,
  estimate,
  busy,
}: {
  label: string;
  token: Token;
  value?: string;
  onChange?: (v: string) => void;
  wallet?: bigint | null;
  vault?: VaultBalance;
  onUnlock?: () => void;
  sealed?: boolean;
  estimate?: bigint | null;
  busy?: boolean;
}) {
  const vaultValue = vault?.kind === "ready" ? vault.value : null;

  /// The most this token could fund a trade with: what is already in the vault
  /// plus what the wallet can still deposit. A locked vault contributes nothing
  /// rather than being guessed at.
  const spendable = (wallet ?? 0n) + (vaultValue ?? 0n);

  return (
    <div className={`field p-4 ${busy ? "scanning" : ""}`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="eyebrow">{label}</span>

        {wallet !== undefined && (
          <span className="flex items-center gap-2 text-[12px] tnum">
            <span style={{ color: "var(--faint)" }}>Wallet</span>
            {wallet === null ? (
              <span style={{ color: "var(--faint)" }}>...</span>
            ) : (
              <span style={{ color: "var(--muted)" }}>
                {formatUnits(wallet, token.decimals, 4)}
              </span>
            )}
            {onChange && spendable > 0n && (
              <button
                className="btn btn-quiet ml-1"
                title="Everything you could trade: your vault balance plus what your wallet can still deposit"
                onClick={() =>
                  onChange(formatUnits(spendable, token.decimals, 6).replace(/,/g, ""))
                }
              >
                MAX
              </button>
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
             is prefixed with the approximation sign and the details row says
             where the real one comes from. */
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

        <div className="ticker shrink-0">
          <TokenIcon symbol={token.symbol} size={20} />
          {token.symbol}
        </div>
      </div>

      {vault && vault.kind !== "idle" && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>
              In HashSwap
            </span>
            <VaultReadout vault={vault} token={token} onUnlock={onUnlock} />
          </div>

          {/* Spelled out, not tucked into a `title`. A tooltip on a phone does
              not exist, and "Could not read" on its own tells the user nothing
              they can act on. */}
          {(vault.kind === "error" || vault.kind === "locked") && (
            <p className="text-[10.5px] mono mt-2 leading-relaxed" style={{ color: "var(--faint)" }}>
              {vault.reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function VaultReadout({
  vault,
  token,
  onUnlock,
}: {
  vault: VaultBalance;
  token: Token;
  onUnlock?: () => void;
}) {
  switch (vault.kind) {
    case "loading":
      return (
        <span className="flex items-center gap-2 text-[12px]" style={{ color: "var(--faint)" }}>
          {/* Deliberately not the redacted block. Reusing it here is what made a
              slow read look like a refusal. */}
          <span className="flow-spin" style={{ width: 9, height: 9 }} />
          Decrypting
        </span>
      );

    case "ready":
      return (
        <span className="text-[12px] tnum" style={{ color: "var(--muted)" }}>
          {formatUnits(vault.value, token.decimals, 4)} {token.symbol}
        </span>
      );

    case "locked":
      /* Recoverable, so it gets a button rather than a block. The gateway wants
         an EIP-712 authorisation the wallet has not signed yet. */
      return (
        <button className="btn btn-quiet text-[11px]" onClick={onUnlock} title={vault.reason}>
          Sign to reveal
        </button>
      );

    case "denied":
      /* The one case the redacted block is honest about: there IS a number here
         and it is not yours to read. */
      return (
        <span className="redacted text-[12px]" style={{ width: 52, height: 11 }} title={vault.reason}>
          ████
        </span>
      );

    case "error":
      return (
        <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--amber)" }}>
          Could not read
          <button className="btn btn-quiet text-[11px]" onClick={onUnlock}>
            Retry
          </button>
        </span>
      );

    default:
      return null;
  }
}
