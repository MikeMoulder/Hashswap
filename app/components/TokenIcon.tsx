"use client";

/// Real token marks, inline.
///
/// Drawn as SVG rather than fetched from a CDN: no extra network hop, no
/// `next/image` remote-host config, nothing to 404 mid-demo, and they stay crisp
/// at every size. Each is the token's actual brand mark in its actual brand
/// colour — the previous coloured circles with letter initials looked like
/// placeholders because that is what they were.

function Ethereum({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#627EEA" />
      <g fill="#fff">
        <path d="M12.15 3v6.65l5.62 2.51z" fillOpacity=".6" />
        <path d="M12.15 3L6.53 12.16l5.62-2.51z" />
        <path d="M12.15 16.48v4.52l5.63-7.79z" fillOpacity=".6" />
        <path d="M12.15 21v-4.52L6.53 13.2z" />
        <path d="M12.15 15.43l5.62-3.27-5.62-2.51z" fillOpacity=".2" />
        <path d="M6.53 12.16l5.62 3.27V9.65z" fillOpacity=".6" />
      </g>
    </svg>
  );
}

function Chainlink({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#2A5ADA" />
      <path
        d="M12 4.6l-1.62.94-4.4 2.54-1.63.94v8.06l1.63.94 4.44 2.54 1.62.94 1.62-.94 4.36-2.54 1.63-.94V9.02l-1.63-.94-4.4-2.54L12 4.6zm-4.4 9.9V9.5L12 7.06l4.4 2.44v5l-4.4 2.44-4.4-2.44z"
        fill="#fff"
      />
    </svg>
  );
}

function Dai({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#F5AC37" />
      <path
        d="M12.28 5.6H6.86v3.86H5v1.63h1.86v1.82H5v1.63h1.86v3.86h5.42c3.28 0 5.98-2.28 6.6-5.49H20v-1.63h-1.06V9.46H20V7.83h-1.14c-.63-3.2-3.32-5.47-6.58-5.47v3.24zm-3.5 11.16v-2.22h8.14a5.06 5.06 0 01-3.65 2.22H8.78zm8.55-3.85H8.78v-1.82h8.55v1.82zm-.4-3.45H8.78V7.24h4.44a5.06 5.06 0 013.71 2.22z"
        fill="#FEFEFD"
      />
    </svg>
  );
}

function Usdc({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#2775CA" />
      <path
        d="M15.3 13.9c0-1.78-1.07-2.39-3.2-2.64-1.52-.2-1.83-.61-1.83-1.32 0-.71.51-1.17 1.52-1.17.92 0 1.42.3 1.68 1.02.05.15.2.25.36.25h.8c.2 0 .36-.15.36-.36v-.05c-.2-1.12-1.12-1.98-2.29-2.08V6.5c0-.2-.15-.36-.4-.4h-.76c-.2 0-.36.15-.36.4v1.07c-1.52.2-2.49 1.22-2.49 2.49 0 1.68 1.02 2.34 3.15 2.59 1.42.25 1.88.56 1.88 1.37 0 .81-.71 1.37-1.68 1.37-1.32 0-1.78-.56-1.93-1.32a.38.38 0 00-.36-.3h-.86c-.2 0-.36.15-.36.36v.05c.2 1.27 1.02 2.19 2.69 2.44v1.07c0 .2.15.36.4.4h.76c.2 0 .36-.15.36-.4v-1.07c1.53-.25 2.54-1.32 2.54-2.69z"
        fill="#fff"
      />
      <path
        d="M9.55 19.2c-3.96-1.42-6-5.84-4.52-9.75a7.51 7.51 0 014.52-4.52c.2-.1.3-.25.3-.51v-.71c0-.2-.1-.36-.3-.4-.05 0-.15 0-.2.05a9.15 9.15 0 000 17.32c.2.1.4 0 .46-.2.05-.05.05-.1.05-.2v-.71c0-.15-.15-.35-.3-.36zm4.9-15.84c-.2-.1-.4 0-.46.2-.05.05-.05.1-.05.2v.71c0 .2.15.4.3.51 3.96 1.42 6 5.84 4.52 9.75a7.51 7.51 0 01-4.52 4.52c-.2.1-.3.25-.3.51v.71c0 .2.1.36.3.4.05 0 .15 0 .2-.05a9.16 9.16 0 000-17.32z"
        fill="#fff"
      />
    </svg>
  );
}

const MARKS: Record<string, (p: { s: number }) => React.ReactNode> = {
  WETH: Ethereum,
  ETH: Ethereum,
  LINK: Chainlink,
  DAI: Dai,
  USDC: Usdc,
};

export function TokenIcon({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const Mark = MARKS[symbol.toUpperCase()];
  if (Mark) return <>{Mark({ s: size })}</>;

  // Unknown token — a neutral disc with the initial, so a new market renders
  // sensibly instead of breaking.
  return (
    <span
      className="grid place-items-center rounded-full shrink-0"
      style={{
        width: size,
        height: size,
        background: "var(--ink-3)",
        border: "1px solid var(--line-2)",
        color: "var(--muted)",
        fontSize: size * 0.42,
        fontWeight: 600,
      }}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}

/// Overlapping pair, as every DEX draws it.
export function TokenPair({
  base,
  quote,
  size = 22,
}: {
  base: string;
  quote: string;
  size?: number;
}) {
  return (
    <span className="inline-flex items-center shrink-0">
      <span style={{ display: "inline-flex", zIndex: 1 }}>
        <TokenIcon symbol={base} size={size} />
      </span>
      <span style={{ display: "inline-flex", marginLeft: -size * 0.32 }}>
        <TokenIcon symbol={quote} size={size} />
      </span>
    </span>
  );
}
