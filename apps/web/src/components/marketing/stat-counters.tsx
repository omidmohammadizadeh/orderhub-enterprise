"use client";

// Phase AP marketing — animated stat counter that counts 0 → target
// when the row scrolls into view. No dependency, ~30 lines of JS.

import { useEffect, useRef, useState } from "react";

interface Stat {
  value: number;
  suffix?: string;
  label: string;
}

const STATS: Stat[] = [
  { value: 5, suffix: "+", label: "Order channels unified" },
  { value: 100, suffix: "%", label: "Margin kept on direct orders" },
  { value: 1, suffix: " inbox", label: "For every order, everywhere" },
];

export function StatCounters() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [start, setStart] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || start) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setStart(true);
          obs.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [start]);

  return (
    <section className="border-y border-zinc-100 bg-white py-16">
      <div
        ref={ref}
        className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 sm:grid-cols-3"
      >
        {STATS.map((s) => (
          <div key={s.label} className="text-center">
            <p className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">
              <Counter target={s.value} start={start} />
              <span className="text-emerald-500">{s.suffix}</span>
            </p>
            <p className="mt-2 text-sm text-zinc-500">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Counter({ target, start }: { target: number; start: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!start) return;
    const duration = 1500;
    const startTime = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setN(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, start]);
  return <>{n.toLocaleString("en-GB")}</>;
}
