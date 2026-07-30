import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

/// Type.
///
/// One family, used with restraint. The previous pairing leaned on Archivo at
/// 800 for display, which read as heavy rather than confident — at large sizes a
/// black grotesque shouts. Inter at 500–600 with tight tracking carries the same
/// hierarchy and looks like an instrument instead of a poster.
///
/// Space Grotesk is the one exception, and it is scoped to the marketing page
/// (`.home` in globals.css) at weight 500. Its wider apertures and squared
/// terminals give the headlines a voice the app itself should not have — the
/// trading surface stays on Inter, where familiarity beats character.

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
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
    <html
      lang="en"
      className={`${inter.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        {/* Scroll reveals start at opacity 0 and are switched on by an
            IntersectionObserver. Without JS nothing would ever switch them on,
            so the homepage would render as a blank column. */}
        <noscript>
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
      </head>
      <body>{children}</body>
    </html>
  );
}
