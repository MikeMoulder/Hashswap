"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CONNECT_REQUEST, type Session } from "@/lib/hashswap";
import { ThemeToggle } from "./ThemeToggle";
import { WalletPicker } from "./WalletPicker";
import { AccountMenu } from "./AccountMenu";
import { MobileNav } from "./MobileNav";

/// Floating navigation.
///
/// A detached pill rather than a full-width band, so the animated grid runs
/// behind and past it instead of being sliced off by an opaque strip. The bolt
/// is narrow enough to sit beside the wordmark without crowding the four links,
/// the theme toggle and the connect button inside 940px.

const LINKS = [
  { href: "/home", label: "Home" },
  { href: "/", label: "Trade" },
  { href: "/docs", label: "Docs" },
  { href: "/terms", label: "Terms" },
];

export function Nav({
  session,
  onConnect,
  connecting,
  error,
  onDisconnect,
}: {
  session: Session | null;
  onConnect: (rdns?: string) => void;
  connecting?: boolean;
  error?: string | null;
  onDisconnect?: () => void;
}) {
  const path = usePathname();

  // The picker lives here because the nav is the one component on every page.
  // Anything else that needs it fires `requestConnect()`.
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const open = () => setPicking(true);
    window.addEventListener(CONNECT_REQUEST, open);
    return () => window.removeEventListener(CONNECT_REQUEST, open);
  }, []);

  // Close on success only — a failed connect leaves the sheet up with the error,
  // so the user can pick a different wallet without reopening it.
  useEffect(() => {
    if (session) setPicking(false);
  }, [session]);

  // The bar tightens once you scroll — it announces itself at rest and gets out
  // of the way in use. `passive` because this fires constantly and must never
  // block scrolling.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
    <div
      className="sticky z-30 flex justify-center px-4"
      style={{ top: 0, paddingTop: scrolled ? 8 : 12, transition: "padding-top 0.3s ease" }}
    >
      <nav className="nav-pill" data-scrolled={scrolled}>
        <span className="sheen-clip" aria-hidden>
          <span className="sheen" />
        </span>
        {/* The mark is decorative: the wordmark beside it already names the link. */}
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <img
            src="/logo.png"
            alt=""
            width={9}
            height={24}
            className="logo-float"
            style={{ display: "block" }}
          />
          <span
            className="text-[15px] font-semibold tracking-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            HashSwap
          </span>
        </Link>

        <div className="hidden sm:flex items-center gap-1">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link" data-active={path === l.href}>
              {l.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />

        {session ? (
          <AccountMenu
            session={session}
            onDisconnect={onDisconnect}
            onSwitch={() => setPicking(true)}
          />
        ) : (
          <button
            className="btn btn-line"
            style={{ borderRadius: 999, padding: "8px 16px" }}
            onClick={() => setPicking(true)}
            disabled={connecting}
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
        </div>
      </nav>

      <WalletPicker
        open={picking}
        onClose={() => setPicking(false)}
        onSelect={onConnect}
        connecting={connecting}
        error={error}
      />
    </div>

    {/* Outside the sticky wrapper on purpose. It is `position: fixed`, and a
        transform on an ancestor would make it a containing block and pin the
        bar to that element instead of the viewport. */}
    <MobileNav />
    </>
  );
}
