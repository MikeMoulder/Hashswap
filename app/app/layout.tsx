import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/// Type.
///
/// One family, used with restraint. The previous pairing leaned on Archivo at
/// 800 for display, which read as heavy rather than confident — at large sizes a
/// black grotesque shouts. Inter at 500–600 with tight tracking carries the same
/// hierarchy and looks like an instrument instead of a poster.

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "HashSwap",
  description:
    "Sealed orders, netted before they reach the pool. Nothing to front-run, nothing to copy.",
};

/// Resolve the theme before first paint.
///
/// Doing this in a React effect would render the default theme, then flip —
/// a white flash on every load for dark-mode users, which is the single most
/// noticeable way to make a polished page feel cheap. It has to be blocking.
const NO_FLASH = `
(function(){
  try {
    var saved = localStorage.getItem('hashswap-theme');
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersLight ? 'light' : 'dark'));
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
