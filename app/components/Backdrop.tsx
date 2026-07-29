"use client";

/// Animated backdrop: a drifting grid, a red bloom behind it, and hand-drawn
/// marks floating at different speeds.
///
/// The marks are all privacy iconography — padlock, keyhole, shield, closed eye,
/// fingerprint, redaction bars, key, mask. Generic squiggles were decoration;
/// these say what the product is in the margins, which is the only reason to
/// have them at all.
///
/// Everything is masked to fade below the fold, so it frames the top of the page
/// rather than tiling the whole thing.

type Doodle = {
  top: string;
  left?: string;
  right?: string;
  rotate: number;
  dur: number;
  delay: number;
  size: number;
  path: React.ReactNode;
};

const DOODLES: Doodle[] = [
  // padlock, shackle closed
  {
    top: "13%", left: "6%", rotate: -11, dur: 7, delay: 0, size: 32,
    path: (
      <>
        <rect x="5" y="11" width="16" height="11" rx="2.5" />
        <path d="M8.5 11V7.5a4.5 4.5 0 019 0V11" />
        <path d="M13 15.5v3" />
      </>
    ),
  },
  // eye, closed — nothing to see
  {
    top: "25%", right: "8%", rotate: 9, dur: 9, delay: 1.2, size: 34,
    path: (
      <>
        <path d="M2 13c4 5 8 7 11 7s7-2 11-7" />
        <path d="M5 17l-2 3M13 20v3.5M21 17l2 3M8.5 19l-1 3M17.5 19l1 3" />
      </>
    ),
  },
  // redaction bars
  {
    top: "57%", left: "10%", rotate: 5, dur: 8, delay: 0.6, size: 34,
    path: (
      <>
        <rect x="2" y="6" width="13" height="3.4" rx="1.2" />
        <rect x="2" y="12" width="21" height="3.4" rx="1.2" />
        <rect x="2" y="18" width="9" height="3.4" rx="1.2" />
      </>
    ),
  },
  // shield
  {
    top: "43%", right: "5%", rotate: -14, dur: 10, delay: 2, size: 30,
    path: (
      <>
        <path d="M13 2l9 3.5v7c0 5.5-4 9.5-9 11.5-5-2-9-6-9-11.5v-7L13 2z" />
        <path d="M9.5 13l2.5 2.5 5-5" />
      </>
    ),
  },
  // keyhole
  {
    top: "71%", right: "15%", rotate: 4, dur: 7.5, delay: 1.6, size: 26,
    path: (
      <>
        <circle cx="13" cy="10" r="4.5" />
        <path d="M11 14l-1.5 8h7L15 14" />
      </>
    ),
  },
  // fingerprint
  {
    top: "79%", left: "17%", rotate: -5, dur: 11, delay: 0.3, size: 30,
    path: (
      <>
        <path d="M4 12a9 9 0 0118 0v3" />
        <path d="M7.5 12.5a5.5 5.5 0 0111 0v4a9 9 0 01-.7 3.5" />
        <path d="M11 12.5a2 2 0 014 0v5c0 1.6-.3 3-.9 4.3" />
        <path d="M6.5 18.5c.6-1.2.9-2.6.9-4" />
      </>
    ),
  },
  // key
  {
    top: "34%", left: "3%", rotate: 22, dur: 8.5, delay: 2.4, size: 28,
    path: (
      <>
        <circle cx="7.5" cy="7.5" r="4.5" />
        <path d="M10.8 10.8L22 22M18.5 18.5l-2.5 2.5M15.5 15.5L13 18" />
      </>
    ),
  },
  // domino mask
  {
    top: "63%", right: "3%", rotate: 12, dur: 9.5, delay: 0.9, size: 32,
    path: (
      <>
        <path d="M2 9c0-2 2-3 5.5-3 2.5 0 4 .8 5.5.8S16 6 18.5 6C22 6 24 7 24 9c0 4-2.5 7-6 7-2.6 0-4-1.6-5-3-1 1.4-2.4 3-5 3-3.5 0-6-3-6-7z" />
      </>
    ),
  },
];

export function Backdrop({ doodles = true }: { doodles?: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      <div className="bloom" />
      <div className="grid-bg" />

      {doodles &&
        DOODLES.map((d, i) => (
          <svg
            key={i}
            className="doodle"
            width={d.size}
            height={d.size}
            viewBox="0 0 26 26"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={
              {
                top: d.top,
                left: d.left,
                right: d.right,
                "--r": `${d.rotate}deg`,
                "--dur": `${d.dur}s`,
                "--delay": `${d.delay}s`,
              } as React.CSSProperties
            }
          >
            {d.path}
          </svg>
        ))}
    </div>
  );
}
