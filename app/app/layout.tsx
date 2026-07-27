import type { Metadata } from "next";
import { Inter, Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/// Type system.
///
/// Archivo for display: a grotesque with genuinely heavy weights, so headlines
/// have mass instead of elegance. Inter runs the UI at 450 base rather than 400
/// — light text on a black ground optically thins out, and the default weight
/// reads as fragile. Mono is reserved for addresses.

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

const display = Archivo({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "HashSwap — Private swaps on Uniswap",
  description:
    "Encrypted orders, netted before they reach the pool. No amount to front-run, no order to copy.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
