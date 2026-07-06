"use client";

// Marketing detail pages — shared "dark high-tech" design kit.
//
// Every Solutions / Integrations detail page composes these primitives so the
// look stays cohesive: a near-black canvas with an emerald→cyan accent, glass
// cards, an animated grid + glow backdrop, scroll-reveal on entry, and device
// frames (browser + phone) that host the product mockups.
//
// It's a client module because the scroll-reveal and count-up need the browser,
// but everything renders fine during SSR (Next hydrates it), so SEO/first paint
// are unaffected.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// ── Scroll reveal ────────────────────────────────────────────────────────────
// Fades + slides children into view. `from` picks the slide direction and
// `delay` staggers siblings. Respects prefers-reduced-motion by snapping in.

type RevealFrom = "up" | "down" | "left" | "right" | "none";

export function Reveal({
  children,
  from = "up",
  delay = 0,
  className = "",
  once = true,
}: {
  children: ReactNode;
  from?: RevealFrom;
  delay?: number;
  className?: string;
  once?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            window.setTimeout(() => setShown(true), delay);
            if (once) obs.disconnect();
          } else if (!once) {
            setShown(false);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delay, once]);

  const hidden: Record<RevealFrom, string> = {
    up: "translate-y-8",
    down: "-translate-y-8",
    left: "-translate-x-8",
    right: "translate-x-8",
    none: "scale-[0.98]",
  };

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out will-change-transform ${
        shown ? "opacity-100 translate-x-0 translate-y-0 scale-100" : `opacity-0 ${hidden[from]}`
      } ${className}`}
    >
      {children}
    </div>
  );
}

// ── Count-up number ──────────────────────────────────────────────────────────

export function CountUp({
  to,
  suffix = "",
  prefix = "",
  decimals = 0,
  className = "",
}: {
  to: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [val, setVal] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let start = 0;
    const dur = 1400;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        obs.disconnect();
        const step = (t: number) => {
          if (!start) start = t;
          const p = Math.min(1, (t - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          setVal(to * eased);
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
}

// ── Backgrounds ──────────────────────────────────────────────────────────────
// Fixed grid + drifting glow orbs. Accent is a hex string so each page can tint
// the whole canvas (emerald by default, brand colour on integration pages).

export function GridGlow({ accent = "#34d399" }: { accent?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* fine grid */}
      <div
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
        }}
      />
      {/* accent glow */}
      <div
        className="absolute -top-40 left-1/2 h-[560px] w-[900px] -translate-x-1/2 rounded-full blur-[120px]"
        style={{ background: `radial-gradient(circle, ${accent}33 0%, transparent 70%)` }}
      />
      <div
        className="absolute right-[-10%] top-[30%] h-[420px] w-[420px] rounded-full blur-[120px]"
        style={{ background: `radial-gradient(circle, ${accent}1f 0%, transparent 70%)` }}
      />
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────

export function Pill({
  children,
  accent = "#34d399",
}: {
  children: ReactNode;
  accent?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
      style={{
        borderColor: `${accent}44`,
        background: `${accent}14`,
        color: accent,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
      {children}
    </span>
  );
}

export function GlassCard({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset,0_20px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

export function GradientText({
  children,
  accent = "#34d399",
}: {
  children: ReactNode;
  accent?: string;
}) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{ backgroundImage: `linear-gradient(120deg, #fff 20%, ${accent} 100%)` }}
    >
      {children}
    </span>
  );
}

// Capability card: icon, title, body. Used in the "what it does" grids.
export function CapabilityCard({
  icon,
  title,
  body,
  accent = "#34d399",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  accent?: string;
}) {
  return (
    <GlassCard className="group h-full p-5 transition-colors hover:border-white/20">
      <div
        className="mb-4 grid h-10 w-10 place-items-center rounded-xl border"
        style={{ borderColor: `${accent}44`, background: `${accent}14`, color: accent }}
      >
        {icon}
      </div>
      <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{body}</p>
    </GlassCard>
  );
}

// ── Device frames ────────────────────────────────────────────────────────────

export function BrowserFrame({
  children,
  url = "orderhub",
  className = "",
}: {
  children: ReactNode;
  url?: string;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1119] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <div className="ml-3 flex-1">
          <div className="mx-auto max-w-[240px] rounded-md bg-white/[0.04] px-3 py-1 text-center text-[10px] text-zinc-500">
            {url}.com
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// Phone frame for the driver / WhatsApp mockups. Fixed 9:19.5-ish aspect.
export function PhoneFrame({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative mx-auto w-[260px] rounded-[2.4rem] border border-white/15 bg-[#05070d] p-2.5 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.9)] ${className}`}
    >
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 h-5 w-24 -translate-x-1/2 rounded-full bg-black" />
      <div className="relative aspect-[9/19] overflow-hidden rounded-[1.9rem] bg-[#0b0f17]">
        {children}
      </div>
    </div>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────

export function SectionHeading({
  eyebrow,
  title,
  body,
  accent = "#34d399",
  center = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  body?: string;
  accent?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <p
          className="text-xs font-semibold uppercase tracking-[0.2em]"
          style={{ color: accent }}
        >
          {eyebrow}
        </p>
      )}
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-[15px] leading-relaxed text-zinc-400">{body}</p>}
    </div>
  );
}
