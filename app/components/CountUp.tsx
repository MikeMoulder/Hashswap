"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// useLayoutEffect warns when React runs it on the server, and there is no
// layout to read there anyway.
const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

/// A figure that counts up the first time it is seen.
///
/// Eased rather than linear. A constant-rate counter reads as a progress bar —
/// something still loading — while decelerating into the final value reads as
/// arriving at it, which is the difference between looking busy and looking
/// finished.
///
/// The server, and the first client render, both emit the real figure. So the
/// number is right without JavaScript, right for anything scraping the DOM, and
/// right for a screen reader, which sees text rather than an animation.
export function CountUp({
  to,
  prefix = "",
  suffix = "",
  duration = 1200,
  className,
  style,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(to);
  const ran = useRef(false);

  // Zero it before the browser paints, not after. In a passive effect the real
  // value reaches the screen for a frame first, and the reset reads as the
  // number glitching backwards — most visible on the hero stats, which are on
  // screen at load and so begin counting immediately.
  useIsoLayout(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || ran.current) return;
        ran.current = true;
        io.disconnect();

        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / duration);
          // easeOutCubic
          setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, duration]);

  return (
    <span ref={ref} className={className} style={style}>
      {prefix}
      {n}
      {suffix}
    </span>
  );
}
