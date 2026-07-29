"use client";

import { useEffect, useRef, useState } from "react";
import { short, type Session } from "@/lib/hashswap";

/// What the connected address expands into.
///
/// The address on its own is a dead end: no way to see which wallet is attached,
/// copy the full string, or get back out. `disconnect` is deliberately local —
/// EIP-1193 has no "log out", so this drops our session and the wallet keeps its
/// own permission grant.

export function AccountMenu({
  session,
  onDisconnect,
  onSwitch,
}: {
  session: Session;
  onDisconnect?: () => void;
  onSwitch?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Dismissal is a document listener rather than a full-screen overlay div: the
  // nav pill sets `backdrop-filter`, which makes it the containing block for
  // fixed-position descendants, so `fixed inset-0` in here would only ever cover
  // the pill itself.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(session.address);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the full address is on screen to select manually */
    }
  }

  return (
    <div className="relative" ref={root}>
      <button
        className="tag mono"
        style={{ color: "var(--paper)", marginLeft: 2, cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="dot" />
        {short(session.address, 4)}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 fade-up"
          style={{
            width: 232,
            background: "var(--ink-1)",
            border: "1px solid var(--line-2)",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 24px 60px -24px rgba(0,0,0,0.9)",
          }}
        >
          <div
            className="px-3 py-2.5"
            style={{ borderBottom: "1px solid var(--line)" }}
          >
            <p
              className="text-[10px] uppercase"
              style={{ color: "var(--faint)", letterSpacing: "0.08em" }}
            >
              {session.walletName}
            </p>
            <p className="text-[11px] mono mt-1 break-all">{session.address}</p>
            <p className="text-[10px] mt-1.5" style={{ color: "var(--faint)" }}>
              {session.market.base.symbol} / {session.market.quote.symbol} ·
              Sepolia
            </p>
          </div>

          <MenuItem onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </MenuItem>
          <MenuItem
            onClick={() =>
              window.open(
                `https://sepolia.etherscan.io/address/${session.address}`,
                "_blank",
                "noopener",
              )
            }
          >
            View on Etherscan ↗
          </MenuItem>
          {onSwitch && (
            <MenuItem
              onClick={() => {
                setOpen(false);
                onSwitch();
              }}
            >
              Switch wallet
            </MenuItem>
          )}
          {onDisconnect && (
            <MenuItem
              danger
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              Disconnect
            </MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className="w-full text-left px-3 py-2.5 text-[12px] font-medium transition-colors"
      style={{
        color: danger ? "var(--red)" : "var(--muted)",
        borderTop: "1px solid var(--line)",
      }}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ink-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
