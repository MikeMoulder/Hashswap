"use client";

import { useCallback, useEffect, useState } from "react";
import { discoverWallets, type WalletOption } from "@/lib/hashswap";

/// Wallet chooser.
///
/// `pickProvider` in lib/hashswap.ts *can* decide for you, but deciding silently
/// is wrong once more than one extension is installed — you end up connected to
/// whichever wallet won the race for `window.ethereum`, with no way to say
/// otherwise. This asks, and hands the chosen EIP-6963 rdns back down so the
/// answer is actually honoured.

const LAST_USED = "hashswap-wallet";

/// Shown only when nothing announced itself. Sepolia + an injected provider is
/// all HashSwap needs, so this is a starting point, not an endorsement.
const INSTALL = [
  { name: "MetaMask", url: "https://metamask.io/download/" },
  { name: "Rabby", url: "https://rabby.io/" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
];

export function WalletPicker({
  open,
  onClose,
  onSelect,
  connecting,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (rdns?: string) => void;
  connecting?: boolean;
  error?: string | null;
}) {
  // `null` means "still listening" — EIP-6963 announcements arrive over a short
  // window, so an empty array is only meaningful once that window has closed.
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [hasInjected, setHasInjected] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWallets(null);
    setChosen(null);
    setHasInjected(!!window.ethereum);
    try {
      setLast(localStorage.getItem(LAST_USED));
    } catch {
      /* private browsing */
    }
    discoverWallets().then(setWallets);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const choose = useCallback(
    (rdns?: string) => {
      setChosen(rdns ?? "injected");
      try {
        if (rdns) localStorage.setItem(LAST_USED, rdns);
      } catch {
        /* private browsing */
      }
      onSelect(rdns);
    },
    [onSelect],
  );

  if (!open) return null;

  // Last wallet used floats to the top; everything else keeps announcement order.
  const sorted = wallets
    ? [...wallets].sort((a, b) => Number(b.info.rdns === last) - Number(a.info.rdns === last))
    : [];
  const empty = wallets !== null && sorted.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a wallet"
    >
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
        onClick={onClose}
      />

      <div className="glass-strong relative w-full fade-up" style={{ maxWidth: 360, padding: 18 }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">Connect a wallet</p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--faint)" }}>
              Sepolia testnet
            </p>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginTop: -2, marginRight: -4 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {wallets === null && (
          <p className="text-[12px] py-6 text-center" style={{ color: "var(--faint)" }}>
            Looking for wallets…
          </p>
        )}

        {sorted.length > 0 && (
          <div className="flex flex-col gap-1">
            {sorted.map((w) => {
              const busy = connecting && chosen === w.info.rdns;
              return (
                <button
                  key={w.info.uuid}
                  className="flex items-center gap-3 px-3 py-2.5 text-left w-full"
                  style={{
                    background: busy ? "var(--ink-2)" : "transparent",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    opacity: connecting && !busy ? 0.4 : 1,
                    cursor: connecting ? "wait" : "pointer",
                  }}
                  disabled={connecting}
                  onClick={() => choose(w.info.rdns)}
                >
                  {/* Wallet-supplied data URI. No next/image — these are inline
                      bytes from the extension, not files we host. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={w.info.icon}
                    alt=""
                    width={26}
                    height={26}
                    style={{ borderRadius: 7, flexShrink: 0 }}
                  />
                  <span className="text-[13px] font-semibold truncate">{w.info.name}</span>
                  <span className="text-[10px] ml-auto shrink-0" style={{ color: "var(--faint)" }}>
                    {busy ? "Connecting…" : w.info.rdns === last ? "Last used" : "Detected"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Wallets predating EIP-6963 announce nothing but still inject the
            global — offer it rather than pretending they are not installed. */}
        {empty && hasInjected && (
          <button
            className="flex items-center gap-3 px-3 py-2.5 text-left w-full"
            style={{ border: "1px solid var(--line)", borderRadius: 10 }}
            disabled={connecting}
            onClick={() => choose(undefined)}
          >
            <span className="text-[13px] font-semibold">Browser wallet</span>
            <span className="text-[10px] ml-auto" style={{ color: "var(--faint)" }}>
              {connecting ? "Connecting…" : "Injected"}
            </span>
          </button>
        )}

        {empty && !hasInjected && (
          <div>
            <p className="text-[12px] mb-2" style={{ color: "var(--muted)" }}>
              No wallet detected in this browser. Install one, then reload:
            </p>
            <div className="flex flex-col gap-1">
              {INSTALL.map((w) => (
                <a
                  key={w.name}
                  href={w.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center px-3 py-2.5 text-[13px] font-semibold"
                  style={{ border: "1px solid var(--line)", borderRadius: 10 }}
                >
                  {w.name}
                  <span className="text-[10px] ml-auto" style={{ color: "var(--faint)" }}>
                    Install ↗
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {error && !connecting && (
          <p className="text-[11px] mono mt-3" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}

        <p className="text-[10px] mt-3 leading-relaxed" style={{ color: "var(--faint)" }}>
          HashSwap never sees your key. Intents are encrypted to the Nox TEE before they
          reach the contract.
        </p>
      </div>
    </div>
  );
}
