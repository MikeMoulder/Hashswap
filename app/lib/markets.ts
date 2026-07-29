"use client";

import registry from "./markets.json";

/// Market registry.
///
/// `baseToken`, `quoteToken` and `poolFee` are immutable on HashSwap, so each
/// market is its own deployment. The frontend reads this list rather than a
/// single address, which is also how a production deployment would be organised.
///
/// Every pool here already existed on Sepolia with real liquidity — we did not
/// create them and do not control them.

export type Token = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  name: string;
};

export type Market = {
  id: string;
  hashswap: `0x${string}`;
  pool: `0x${string}`;
  fee: number;
  refPrice: string;
  base: Token;
  quote: Token;
};

export const UNISWAP = registry.uniswap as {
  factory: `0x${string}`;
  positionManager: `0x${string}`;
  swapRouter02: `0x${string}`;
  quoterV2: `0x${string}`;
};

export const MARKETS = registry.markets as unknown as Market[];

/// WETH/LINK leads because it is the only one whose pool price resembles the
/// real world (~225 LINK per WETH). The others are genuine pools with genuine
/// liquidity, but testnet pools are seeded at arbitrary prices — see
/// `priceIsRealistic`.
export const DEFAULT_MARKET = "WETH-LINK";

export function getMarket(id: string): Market {
  return MARKETS.find((m) => m.id === id) ?? MARKETS[0];
}

/// Whether a market's pool price is close enough to reality to quote without a
/// caveat. Testnet pools are seeded arbitrarily, so a market can be perfectly
/// functional and still price 1 WETH at six million DAI. Better to label that
/// than let it look like a bug in our maths.
const REALISTIC: Record<string, [number, number]> = {
  "WETH-LINK": [50, 2000],
  "WETH-DAI": [500, 20000],
  "LINK-USDC": [2, 60],
};

export function humanPrice(m: Market): number {
  return (Number(m.refPrice) / 1e18) * 10 ** (m.base.decimals - m.quote.decimals);
}

export function priceIsRealistic(m: Market): boolean {
  const range = REALISTIC[m.id];
  if (!range) return true;
  const p = humanPrice(m);
  return p >= range[0] && p <= range[1];
}

/// Format a token amount using that token's own decimals. USDC is 6, everything
/// else here is 18 — assuming 18 everywhere silently renders USDC amounts a
/// trillion times too small.
export function formatUnits(v: bigint, decimals: number, dp = 4): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  let fracStr = frac.toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${neg ? "-" : ""}${wholeStr}${fracStr ? `.${fracStr}` : ""}`;
}

export function parseUnits(value: string, decimals: number): bigint {
  const [w, f = ""] = value.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
