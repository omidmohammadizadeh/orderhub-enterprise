"use client";

// Product mockups for the Solutions detail pages. Pure CSS/SVG so they stay
// crisp at any size and need no screenshot assets. The driver mockups mirror
// the real apps/driver React Native screens (dark "Order Hub Driver" top bar,
// live map, online toggle, slide-to-confirm) so the marketing page shows the
// actual interface.

import {
  Bike,
  Check,
  ChevronRight,
  MapPin,
  Menu as MenuIcon,
  Navigation,
  Phone,
  Banknote,
} from "lucide-react";
import { BrowserFrame, PhoneFrame } from "./kit";

const UBER = "#06C167";
const ROO = "#00CCBC";

// ── POS orders board ─────────────────────────────────────────────────────────

export function PosBoardMockup() {
  const cols: { name: string; tint: string; n: number }[] = [
    { name: "New", tint: "#f97316", n: 3 },
    { name: "Preparing", tint: "#3b82f6", n: 2 },
    { name: "Ready", tint: "#34d399", n: 2 },
  ];
  const brandDot = (i: number) => (i % 3 === 0 ? UBER : i % 3 === 1 ? ROO : "#a78bfa");
  return (
    <BrowserFrame url="app.orderhub">
      <div className="grid grid-cols-3 gap-2.5 p-3.5">
        {cols.map((c) => (
          <div key={c.name}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-white">{c.name}</span>
              <span
                className="rounded-full px-1.5 text-[10px] font-bold"
                style={{ background: `${c.tint}22`, color: c.tint }}
              >
                {c.n}
              </span>
            </div>
            <div className="space-y-2">
              {Array.from({ length: c.n }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-white/10 bg-white/[0.04] p-2"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: brandDot(i) }}
                    />
                    <span className="font-mono text-[10px] font-bold text-white">
                      #{1043 + i}
                    </span>
                    <span className="ml-auto text-[9px] text-zinc-500">
                      {6 + i}m
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-4/5 rounded-full bg-white/10" />
                  <div className="mt-1 h-1.5 w-1/2 rounded-full bg-white/[0.07]" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </BrowserFrame>
  );
}

// ── Storefront ───────────────────────────────────────────────────────────────

export function StorefrontMockup() {
  return (
    <BrowserFrame url="order.yourshop">
      <div>
        <div className="relative h-24 bg-gradient-to-br from-orange-400 via-orange-500 to-rose-500">
          <div className="absolute -bottom-4 left-4 grid h-11 w-11 place-items-center rounded-xl bg-[#0d1119] ring-2 ring-[#0d1119]">
            <Bike className="h-5 w-5 text-orange-400" />
          </div>
        </div>
        <div className="px-4 pb-4 pt-6">
          <div className="h-3 w-1/2 rounded bg-white/20" />
          <div className="mt-2 flex gap-2">
            <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[10px] font-semibold text-white">
              Delivery
            </span>
            <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[10px] font-semibold text-zinc-400">
              Collection
            </span>
            <span className="ml-auto rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[10px] font-semibold text-zinc-400">
              20–30 min
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
                <div className="aspect-square rounded-md bg-gradient-to-br from-white/10 to-white/[0.03]" />
                <div className="mt-1.5 h-1.5 w-3/4 rounded bg-white/15" />
                <div className="mt-1 h-1.5 w-1/3 rounded bg-emerald-400/40" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Menu manager ─────────────────────────────────────────────────────────────

export function MenuManagerMockup() {
  const cats = ["Pizza", "Burgers", "Sides", "Drinks", "Desserts"];
  return (
    <BrowserFrame url="app.orderhub">
      <div className="grid grid-cols-[92px,1fr] gap-3 p-3.5">
        <div className="space-y-1.5">
          {cats.map((c, i) => (
            <div
              key={c}
              className={`rounded-lg px-2 py-1.5 text-[10px] font-semibold ${
                i === 0
                  ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/30"
                  : "border border-white/10 bg-white/[0.03] text-zinc-400"
              }`}
            >
              {c}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-2"
            >
              <div className="h-9 w-9 flex-shrink-0 rounded-md bg-gradient-to-br from-orange-400/40 to-rose-500/30" />
              <div className="flex-1">
                <div className="h-1.5 w-3/4 rounded bg-white/15" />
                <div className="mt-1.5 flex gap-1">
                  <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[8px] text-zinc-400">
                    3 sizes
                  </span>
                  <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[8px] text-zinc-400">
                    +mods
                  </span>
                </div>
              </div>
              <div className="text-[10px] font-semibold text-emerald-300">
                £{9 + i}.50
              </div>
            </div>
          ))}
          <div className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 py-2 text-[10px] text-zinc-500">
            Publish to 5 channels
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Driver app — Home (live map + online toggle) ─────────────────────────────

export function DriverHomeMockup() {
  return (
    <PhoneFrame>
      {/* map */}
      <div className="absolute inset-0 bg-[#0f1523]">
        <svg viewBox="0 0 260 560" className="h-full w-full opacity-70">
          <defs>
            <pattern id="roads" width="60" height="60" patternUnits="userSpaceOnUse">
              <path d="M0 30 H60 M30 0 V60" stroke="#1e293b" strokeWidth="6" />
            </pattern>
          </defs>
          <rect width="260" height="560" fill="url(#roads)" />
          <path d="M-10 300 C 80 240, 150 360, 280 300" stroke="#334155" strokeWidth="10" fill="none" />
          <path d="M130 -10 C 90 160, 170 320, 130 570" stroke="#334155" strokeWidth="10" fill="none" />
        </svg>
        {/* driver marker */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="grid h-9 w-9 place-items-center rounded-full border-2 border-blue-500 bg-white text-base shadow-lg">
            🚗
          </div>
          <div className="absolute inset-0 -z-10 animate-ping rounded-full bg-blue-500/30" />
        </div>
      </div>
      {/* top bar */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-[rgba(15,23,42,0.94)] px-3 pb-2.5 pt-8">
        <div className="flex w-6 flex-col gap-[3px]">
          <span className="h-[2px] rounded bg-white" />
          <span className="h-[2px] rounded bg-white" />
          <span className="h-[2px] rounded bg-white" />
        </div>
        <span className="text-xs font-extrabold text-white">Order Hub Driver</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-emerald-400">Online</span>
          <span className="flex h-4 w-7 items-center rounded-full bg-emerald-500 px-0.5">
            <span className="ml-auto h-3 w-3 rounded-full bg-white" />
          </span>
        </div>
      </div>
      {/* resume card */}
      <div className="absolute inset-x-3 bottom-4 flex items-center gap-2 rounded-2xl bg-orange-500 p-3 shadow-lg">
        <div className="flex-1">
          <p className="text-[12px] font-extrabold text-white">Delivery in progress</p>
          <p className="text-[10px] text-white/90">Tap to resume your current stop</p>
        </div>
        <span className="text-[12px] font-extrabold text-white">Resume ›</span>
      </div>
    </PhoneFrame>
  );
}

// ── Driver app — Job (stops + slide to confirm) ──────────────────────────────

export function DriverJobMockup() {
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col bg-[#0b0f17]">
        <div className="bg-[rgba(15,23,42,0.94)] px-3 pb-3 pt-8">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            Active delivery · #1043
          </p>
          <p className="mt-0.5 text-sm font-extrabold text-white">Uber Eats · £24.80</p>
        </div>
        <div className="flex-1 space-y-2.5 p-3">
          <div className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
            <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
                Pick up
              </p>
              <p className="text-[11px] font-semibold text-white">Pizza Uno, Pelton</p>
            </div>
            <Check className="ml-auto h-4 w-4 text-emerald-400" />
          </div>
          <div className="ml-[9px] h-4 w-[2px] rounded bg-white/10" />
          <div className="flex items-start gap-2.5 rounded-xl border border-orange-400/30 bg-orange-500/10 p-2.5">
            <Navigation className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-400" />
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider text-orange-300">
                Drop off · 1.2 mi
              </p>
              <p className="text-[11px] font-semibold text-white">14 Front St, DH2</p>
            </div>
          </div>
          <button className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-2 text-[11px] font-semibold text-zinc-300">
            <Phone className="h-3.5 w-3.5" /> Call customer
          </button>
        </div>
        {/* slide to confirm */}
        <div className="p-3">
          <div className="relative flex h-11 items-center overflow-hidden rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30">
            <div className="absolute left-1 grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-white shadow">
              <ChevronRight className="h-5 w-5" />
            </div>
            <span className="w-full text-center text-[11px] font-bold text-emerald-300">
              Slide to mark delivered
            </span>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Dispatch console (web) ───────────────────────────────────────────────────

export function DispatchConsoleMockup() {
  const drivers = [
    { name: "Sam K.", state: "On job", tint: "#f97316", jobs: 2 },
    { name: "Priya R.", state: "Online", tint: "#34d399", jobs: 0 },
    { name: "Deniz A.", state: "On job", tint: "#f97316", jobs: 1 },
    { name: "Jack M.", state: "Offline", tint: "#64748b", jobs: 0 },
  ];
  return (
    <BrowserFrame url="app.orderhub">
      <div className="grid grid-cols-[1fr,150px]">
        {/* map */}
        <div className="relative h-[220px] bg-[#0f1523]">
          <svg viewBox="0 0 320 220" className="h-full w-full opacity-70">
            <pattern id="d-roads" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M0 24 H48 M24 0 V48" stroke="#1e293b" strokeWidth="5" />
            </pattern>
            <rect width="320" height="220" fill="url(#d-roads)" />
            <path d="M20 40 C 120 60, 180 160, 300 120" stroke="#334155" strokeWidth="7" fill="none" />
          </svg>
          {[
            { x: "22%", y: "34%", t: "#f97316" },
            { x: "58%", y: "60%", t: "#34d399" },
            { x: "74%", y: "40%", t: "#f97316" },
          ].map((p, i) => (
            <div
              key={i}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: p.x, top: p.y }}
            >
              <div
                className="grid h-6 w-6 place-items-center rounded-full text-white shadow-lg"
                style={{ background: p.t }}
              >
                <Bike className="h-3.5 w-3.5" />
              </div>
            </div>
          ))}
          <div className="absolute left-[44%] top-[46%] -translate-x-1/2 -translate-y-1/2">
            <MapPin className="h-6 w-6 fill-rose-500/30 text-rose-400" />
          </div>
        </div>
        {/* driver list */}
        <div className="border-l border-white/10 p-2.5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Fleet · 4
          </p>
          <div className="space-y-1.5">
            {drivers.map((d) => (
              <div
                key={d.name}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5"
              >
                <span className="h-2 w-2 rounded-full" style={{ background: d.tint }} />
                <span className="text-[10px] font-semibold text-white">{d.name}</span>
                <span className="ml-auto text-[8px] text-zinc-500">{d.state}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── WhatsApp AI ordering ─────────────────────────────────────────────────────

export function WhatsAppChatMockup() {
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col bg-[#0b141a]">
        <div className="flex items-center gap-2.5 bg-[#1f2c34] px-3 pb-2.5 pt-8">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-emerald-500 text-sm font-bold text-white">
            🍕
          </div>
          <div>
            <p className="text-[12px] font-bold text-white">Pizza Uno</p>
            <p className="text-[9px] text-emerald-300">online · replies instantly</p>
          </div>
        </div>
        <div
          className="flex-1 space-y-2 p-3"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        >
          <Bubble side="in">Hi! What can I get you tonight? 🍕</Bubble>
          <Bubble side="out">Large pepperoni + garlic bread</Bubble>
          <Bubble side="in">
            Great — Large Pepperoni (£12.50) & Garlic Bread (£4). Delivery to 14 Front St?
          </Bubble>
          <Bubble side="out">yes please</Bubble>
          <Bubble side="in" pay>
            Tap to pay £16.50 securely →
          </Bubble>
        </div>
      </div>
    </PhoneFrame>
  );
}

function Bubble({
  children,
  side,
  pay = false,
}: {
  children: React.ReactNode;
  side: "in" | "out";
  pay?: boolean;
}) {
  const out = side === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-2.5 py-1.5 text-[10px] leading-snug ${
          out
            ? "rounded-br-sm bg-emerald-600 text-white"
            : pay
              ? "rounded-bl-sm bg-white text-emerald-700 font-semibold"
              : "rounded-bl-sm bg-[#1f2c34] text-zinc-100"
        }`}
      >
        {pay && <Banknote className="mr-1 inline h-3 w-3" />}
        {children}
      </div>
    </div>
  );
}

// ── Table floor plan ─────────────────────────────────────────────────────────
// Mirrors the real Tables screen: colour-coded tiles, occupied tables carrying
// their running total and how long they've been seated.
export function FloorPlanMockup() {
  const tables = [
    { name: "T1", seats: 2, state: "free" as const },
    { name: "T2", seats: 4, state: "busy" as const, total: "48.20", mins: 42 },
    { name: "T3", seats: 4, state: "free" as const },
    { name: "T4", seats: 6, state: "busy" as const, total: "112.60", mins: 18 },
    { name: "T5", seats: 2, state: "bill" as const, total: "31.00", mins: 65 },
    { name: "T6", seats: 4, state: "free" as const },
  ];
  return (
    <BrowserFrame>
      <div className="bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-bold text-zinc-900">Main floor</p>
            <p className="text-[10px] text-zinc-400">2 free · 3 occupied</p>
          </div>
          <div className="flex gap-2 text-[9px]">
            <span className="flex items-center gap-1 text-zinc-500">
              <i className="h-2 w-2 rounded-full bg-emerald-400" /> Free
            </span>
            <span className="flex items-center gap-1 text-zinc-500">
              <i className="h-2 w-2 rounded-full bg-amber-400" /> Seated
            </span>
            <span className="flex items-center gap-1 text-zinc-500">
              <i className="h-2 w-2 rounded-full bg-violet-400" /> Bill asked
            </span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tables.map((t) => (
            <div
              key={t.name}
              className={
                "rounded-lg border p-2.5 " +
                (t.state === "free"
                  ? "border-emerald-200 bg-emerald-50/60"
                  : t.state === "bill"
                    ? "border-violet-200 bg-violet-50/60"
                    : "border-amber-200 bg-amber-50/60")
              }
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-zinc-900">
                  {t.name}
                </span>
                <span className="text-[9px] text-zinc-400">{t.seats}p</span>
              </div>
              {t.state === "free" ? (
                <p className="mt-1.5 text-[10px] font-medium text-emerald-600">
                  Available
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-[12px] font-bold text-zinc-900">
                    £{t.total}
                  </p>
                  <p className="text-[9px] text-zinc-400">{t.mins} min</p>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Split-the-bill sheet ─────────────────────────────────────────────────────
export function SplitBillMockup() {
  const rows = [
    { name: "Mixed Grill", price: "18.50", paid: true },
    { name: "Chicken Shish", price: "13.90", paid: true },
    { name: "Lamb Doner", price: "12.40", paid: false },
    { name: "Halloumi Fries", price: "6.50", paid: false },
  ];
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col bg-white">
        <div className="border-b border-zinc-100 px-4 py-3">
          <p className="text-[13px] font-bold text-zinc-900">Table 4 · Split</p>
          <p className="text-[10px] text-zinc-400">Tap items to pay for them</p>
        </div>
        <div className="flex-1 space-y-1.5 p-3">
          {rows.map((r) => (
            <div
              key={r.name}
              className={
                "flex items-center justify-between rounded-lg border px-3 py-2 " +
                (r.paid
                  ? "border-zinc-100 bg-zinc-50"
                  : "border-zinc-200 bg-white")
              }
            >
              <span
                className={
                  "text-[11px] font-medium " +
                  (r.paid ? "text-zinc-300 line-through" : "text-zinc-800")
                }
              >
                {r.name}
              </span>
              <span
                className={
                  "text-[11px] font-bold " +
                  (r.paid ? "text-zinc-300 line-through" : "text-zinc-900")
                }
              >
                £{r.price}
              </span>
            </div>
          ))}
        </div>
        <div className="border-t border-zinc-100 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Left to pay</span>
            <span className="font-bold text-zinc-900">£18.90</span>
          </div>
          <div className="rounded-lg bg-zinc-900 py-2 text-center text-[11px] font-bold text-white">
            Charge card reader
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Caller ID pop-up ─────────────────────────────────────────────────────────
// The card that lands on every till the moment the landline rings.
export function CallerIdMockup() {
  return (
    <BrowserFrame>
      <div className="bg-zinc-50 p-5">
        <div className="mx-auto max-w-[300px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 bg-emerald-500 px-3 py-2">
            <Phone className="h-3.5 w-3.5 text-white" />
            <span className="text-[11px] font-bold text-white">
              Incoming call
            </span>
            <span className="ml-auto text-[10px] text-white/80">now</span>
          </div>
          <div className="p-3.5">
            <p className="text-[15px] font-bold text-zinc-900">Sarah Whitton</p>
            <p className="text-[11px] text-zinc-500">0191 486 2909</p>
            <div className="mt-2 inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[9px] font-bold text-violet-700">
              RETURNING · 14 ORDERS
            </div>
            <div className="mt-3 rounded-lg bg-zinc-50 p-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
                Last address
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-700">
                12 Rectory Road, Gateshead, NE8 4EJ
              </p>
              <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
                Usual order
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-700">
                Large Pepperoni · Garlic Bread
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-zinc-200 py-1.5 text-center text-[10px] font-semibold text-zinc-600">
                Dismiss
              </div>
              <div className="rounded-lg bg-zinc-900 py-1.5 text-center text-[10px] font-bold text-white">
                Start order
              </div>
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}
