"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/// Scroll-triggered entrance.
///
/// The observer disconnects on first intersection — these fire once and never
/// again, so keeping them subscribed would cost scroll work for nothing.
///
/// Anyone whose OS asks for less motion is shown the content immediately, with
/// the transition removed rather than shortened. A fast animation is still an
/// animation, and the whole point of the setting is that some people are made
/// ill by movement they did not ask for.
export function Reveal({
  children,
  delay = 0,
  className = "",
  style,
}: {
  children: ReactNode;
  /// Stagger, in ms. Applied as a transition-delay, so siblings can cascade.
  delay?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShown(true);
        io.disconnect();
      },
      // Held back from the very bottom of the viewport so the reveal reads as
      // the section arriving, not as it scraping into view.
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${className}`}
      data-shown={shown}
      style={{ ...style, "--d": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}
