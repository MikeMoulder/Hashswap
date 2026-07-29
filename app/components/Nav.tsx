"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { short, type Session } from "@/lib/hashswap";
import { Mark } from "./Footer";

/// Shared navigation. On the marketing page the primary action is "Launch app";
/// once you are inside the app it becomes the wallet control, so there is never
/// more than one red element competing for attention.
export function Nav({
  session,
  onConnect,
  connecting,
}: {
  session: Session | null;
  onConnect: (rdns?: string) => void;
  connecting?: boolean;
}) {
  const path = usePathname();
  const onSwap = path?.startsWith("/swap");

  return (
    <nav
      className="sticky top-0 z-20"
      style={{
        borderBottom: "1px solid var(--line)",
        background: "rgba(8,8,10,0.86)",
        backdropFilter: "blur(14px)",
      }}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-bold tracking-tight">HashSwap</span>
        </Link>

        <div className="hidden md:flex items-center gap-8 text-[13px] font-medium">
          <Link href="/#how" style={{ color: "var(--muted)" }}>
            How it works
          </Link>
          <Link href="/#private" style={{ color: "var(--muted)" }}>
            Privacy
          </Link>
          <Link href="/swap" style={{ color: onSwap ? "var(--paper)" : "var(--muted)" }}>
            Trade
          </Link>
        </div>

        {onSwap ? (
          session ? (
            <span className="tag mono">{short(session.address, 6)}</span>
          ) : (
            <button className="btn btn-line" onClick={() => onConnect()} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )
        ) : (
          <Link href="/swap" className="btn btn-red" style={{ width: "auto", padding: "10px 20px", fontSize: 13 }}>
            Launch app
          </Link>
        )}
      </div>
    </nav>
  );
}
