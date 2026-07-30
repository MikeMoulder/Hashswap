"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/// Bottom navigation, phones only.
///
/// The top pill keeps the brand, the theme toggle and the wallet button, and
/// drops its links below `sm` — there is no room for four of them beside a
/// wallet button on a 375px screen. They reappear here instead, at the bottom,
/// where a thumb actually reaches.
///
/// Scrolling down folds it shut around the current page's icon; scrolling up
/// opens it again. Reading is the common case and this is chrome, so it gets
/// out of the way going forward and returns the moment you reverse — but it
/// never leaves the screen, so there is always something to tap back open.

const ITEMS = [
  {
    href: "/home",
    label: "Home",
    icon: (
      <>
        <path d="M3 10.6 12 3.4l9 7.2" />
        <path d="M5.6 9.4V20.6h12.8V9.4" />
      </>
    ),
  },
  {
    href: "/",
    label: "Trade",
    icon: (
      <>
        <path d="M4 8.5h13l-3.2-3.2" />
        <path d="M20 15.5H7l3.2 3.2" />
      </>
    ),
  },
  {
    href: "/docs",
    label: "Docs",
    icon: (
      <>
        <path d="M5 4.4h9.5L19 8.9v10.7H5z" />
        <path d="M14 4.4v4.8h4.8M8.3 13h7.4M8.3 16.4h5" />
      </>
    ),
  },
  {
    href: "/terms",
    label: "Terms",
    icon: (
      <>
        <path d="M12 3.2l7.2 2.7v6.2c0 4.3-3.2 7.5-7.2 9.1-4-1.6-7.2-4.8-7.2-9.1V5.9z" />
        <path d="M9.2 12.2l2 2 3.6-3.8" />
      </>
    ),
  },
];

export function MobileNav() {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;

    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;

      // A threshold, not a raw comparison. Sub-pixel scroll jitter and iOS
      // rubber-banding at either end both produce a stream of tiny alternating
      // deltas, which would otherwise flip the bar on almost every frame.
      if (Math.abs(dy) < 6) return;

      // Always open near the top, whichever way the last gesture went —
      // arriving at a page with the nav already shut feels broken.
      setCollapsed(y > 80 && dy > 0);
      lastY.current = y;
    };

    onScroll();
    // `passive`: this fires constantly and must never delay a scroll.
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className="mobile-nav" data-collapsed={collapsed} aria-label="Primary">
      {ITEMS.map((it) => {
        const active = path === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className="mobile-nav-item"
            data-active={active}
            aria-current={active ? "page" : undefined}
            // The visible label is gone, so the name has to come from here —
            // an icon-only link is unlabelled to a screen reader otherwise.
            aria-label={it.label}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {it.icon}
            </svg>
          </Link>
        );
      })}
    </nav>
  );
}
