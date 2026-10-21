"use client";

// Mockups for the non-restaurant Solutions pages: the walk-in loyalty card,
// supermarkets and salons / barbers. Same rules as mockups.tsx — pure CSS, no
// screenshots — and each one mirrors a screen that really exists in the
// product (wallet pass, scan till, picking, salon diary, booking page, queue).

import { Check, Coffee, ScanLine, Scissors, ShieldCheck, Sparkles, Star, Users } from "lucide-react";
import { BrowserFrame, PhoneFrame } from "./kit";

const LOYALTY = "#f472b6";
const GROCERY = "#22c55e";
const BEAUTY = "#e879f9";
const BARBER = "#f59e0b";

// ── Loyalty: the card in the phone's wallet ─────────────────────────────────

export function WalletPassMockup() {
  const stamps = 10;
  const earned = 7;
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col bg-black px-3 pb-5 pt-10">
        <p className="px-1 text-[17px] font-bold text-white">Wallet</p>
        <div
          className="mt-3 overflow-hidden rounded-2xl shadow-lg"
          style={{ background: "linear-gradient(160deg,#3b0a24,#1a0b1f)" }}
        >
          <div className="flex items-center justify-between px-3.5 pt-3">
            <span className="text-[12px] font-bold text-white">Bean & Bloom</span>
            <span className="text-right">
              <span className="block text-[8px] uppercase tracking-wide text-pink-200/70">Stamps</span>
              <span className="block text-[13px] font-bold text-white">
                {earned} / {stamps}
              </span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5 px-3.5">
            {Array.from({ length: stamps }).map((_, i) => (
              <span
                key={i}
                className="grid aspect-square place-items-center rounded-full border"
                style={
                  i < earned
                    ? { background: LOYALTY, borderColor: LOYALTY, color: "#2a0718" }
                    : { borderColor: "rgba(255,255,255,0.25)", color: "rgba(255,255,255,0.25)" }
                }
              >
                <Coffee className="h-3 w-3" />
              </span>
            ))}
          </div>
          <div className="mt-3 flex justify-between px-3.5 text-[9px]">
            <span>
              <span className="block uppercase tracking-wide text-pink-200/70">Reward</span>
              <span className="font-semibold text-white">Free coffee</span>
            </span>
            <span className="text-right">
              <span className="block uppercase tracking-wide text-pink-200/70">Member</span>
              <span className="font-semibold text-white">Sarah W.</span>
            </span>
          </div>
          <div className="mx-auto my-4 grid h-24 w-24 place-items-center rounded-lg bg-white p-2">
            <QrGlyph />
          </div>
        </div>
        <div className="mt-3 rounded-xl bg-white/[0.06] p-2.5">
          <p className="text-[10px] font-semibold text-white">3 more for a free coffee</p>
          <p className="mt-0.5 text-[9px] text-zinc-400">Updated just now · stamped at the till</p>
        </div>
      </div>
    </PhoneFrame>
  );
}

// A deterministic, QR-looking block pattern. Decorative only.
function QrGlyph() {
  const cells = Array.from({ length: 81 }, (_, i) => ((i * 7 + (i % 5) * 3) % 11) < 5);
  return (
    <div className="grid h-full w-full grid-cols-9 gap-[1px]">
      {cells.map((on, i) => (
        <span key={i} className={on ? "bg-zinc-900" : "bg-white"} />
      ))}
    </div>
  );
}

// ── Loyalty: the till after the card is scanned ─────────────────────────────

export function LoyaltyTillMockup() {
  return (
    <BrowserFrame url="app.orderhub">
      <div className="grid grid-cols-[1.3fr_1fr] gap-3 p-3.5">
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Basket</p>
          {[
            ["Flat white", "3.40"],
            ["Almond croissant", "3.10"],
            ["Banana bread", "2.80"],
          ].map(([n, p]) => (
            <div key={n} className="mt-2 flex justify-between text-[11px] text-zinc-200">
              <span>{n}</span>
              <span className="tabular-nums">£{p}</span>
            </div>
          ))}
          <div className="mt-3 flex justify-between border-t border-white/10 pt-2 text-[12px] font-bold text-white">
            <span>Total</span>
            <span className="tabular-nums">£9.30</span>
          </div>
        </div>
        <div
          className="rounded-lg border p-2.5"
          style={{ borderColor: `${LOYALTY}55`, background: `${LOYALTY}12` }}
        >
          <div className="flex items-center gap-1.5">
            <ScanLine className="h-3.5 w-3.5" style={{ color: LOYALTY }} />
            <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: LOYALTY }}>
              Card scanned
            </span>
          </div>
          <p className="mt-2 text-[13px] font-bold text-white">Sarah Whitton</p>
          <p className="text-[10px] text-zinc-400">7 of 10 stamps</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[70%] rounded-full" style={{ background: LOYALTY }} />
          </div>
          <div className="mt-3 rounded-md bg-white/[0.06] px-2 py-1.5 text-[10px] text-zinc-300">
            +1 stamp when this sale is paid
          </div>
          <div className="mt-2 flex items-center gap-1 text-[10px] text-emerald-300">
            <Check className="h-3 w-3" /> Wallet updates on its own
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Supermarkets: the scan till ─────────────────────────────────────────────

export function GroceryTillMockup() {
  const lines: { name: string; meta: string; price: string; flag?: string }[] = [
    { name: "Semi-skimmed milk 2L", meta: "5010029", price: "1.65" },
    { name: "Bananas", meta: "0.86 kg @ £1.20/kg", price: "1.03", flag: "Weighed" },
    { name: "Sourdough loaf", meta: "5060123", price: "2.50" },
    { name: "Any 3 for £5 — crisps", meta: "Multi-buy", price: "-1.25", flag: "Deal" },
    { name: "Red wine 75cl", meta: "Age checked", price: "7.99", flag: "18+" },
  ];
  return (
    <BrowserFrame url="app.orderhub">
      <div className="p-3.5">
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2">
          <ScanLine className="h-4 w-4" style={{ color: GROCERY }} />
          <span className="text-[11px] text-zinc-400">Scan or search a product…</span>
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold"
            style={{ background: `${GROCERY}22`, color: GROCERY }}
          >
            SCANNER ON
          </span>
        </div>
        <div className="mt-2.5 space-y-1.5">
          {lines.map((l) => (
            <div
              key={l.name}
              className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-white">{l.name}</p>
                <p className="text-[9px] text-zinc-500">{l.meta}</p>
              </div>
              {l.flag && (
                <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[8px] font-bold uppercase text-zinc-300">
                  {l.flag}
                </span>
              )}
              <span className="w-12 text-right text-[11px] tabular-nums text-zinc-200">£{l.price}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg px-3 py-2" style={{ background: GROCERY }}>
          <span className="text-[12px] font-bold text-[#04120c]">Pay £11.92</span>
          <span className="text-[10px] font-semibold text-[#04120c]/70">Cash · Card · Contactless</span>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Supermarkets: picking an online order ───────────────────────────────────

export function GroceryPickingMockup() {
  const rows: { name: string; state: "picked" | "sub" | "short" | "todo"; note: string }[] = [
    { name: "Free-range eggs x12", state: "picked", note: "Picked" },
    { name: "Oat milk 1L", state: "sub", note: "Swapped for Barista oat 1L" },
    { name: "Chicken breast", state: "picked", note: "612 g weighed" },
    { name: "Basmati rice 1kg", state: "short", note: "Out — £2.10 refunded" },
    { name: "Cherry tomatoes", state: "todo", note: "Aisle 2" },
  ];
  const tint = { picked: GROCERY, sub: "#38bdf8", short: "#f87171", todo: "#71717a" };
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col px-3 pb-5 pt-10">
        <p className="text-[10px] text-zinc-500">Picking · order #2081</p>
        <p className="text-[15px] font-bold text-white">Collection 17:30</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-4/5 rounded-full" style={{ background: GROCERY }} />
        </div>
        <div className="mt-3 space-y-2">
          {rows.map((r) => (
            <div key={r.name} className="flex items-start gap-2 rounded-lg bg-white/[0.04] p-2">
              <span
                className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full"
                style={{ background: `${tint[r.state]}33`, color: tint[r.state] }}
              >
                {r.state !== "todo" && <Check className="h-2.5 w-2.5" />}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-white">{r.name}</p>
                <p className="text-[9px]" style={{ color: tint[r.state] }}>
                  {r.note}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-auto rounded-lg py-2 text-center text-[11px] font-bold text-[#04120c]" style={{ background: GROCERY }}>
          Mark ready
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Salons & barbers: the diary, one column per stylist ─────────────────────

type DiaryBlock = { top: number; h: number; who: string; what: string; tone?: "paid" | "gap" | "off" };

export function SalonDiaryMockup({
  accent = BEAUTY,
  staff,
}: {
  accent?: string;
  staff: { name: string; blocks: DiaryBlock[] }[];
}) {
  const hours = ["9:00", "10:00", "11:00", "12:00", "13:00"];
  return (
    <BrowserFrame url="app.orderhub">
      <div className="p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-bold text-white">Today · Saturday</span>
          <span className="rounded-full px-2 py-0.5 text-[9px] font-bold" style={{ background: `${accent}22`, color: accent }}>
            Takings £412
          </span>
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `34px repeat(${staff.length}, 1fr)` }}>
          <div />
          {staff.map((s) => (
            <div key={s.name} className="truncate text-center text-[10px] font-semibold text-zinc-300">
              {s.name}
            </div>
          ))}
          <div className="relative h-[200px]">
            {hours.map((h, i) => (
              <span key={h} className="absolute left-0 text-[8px] text-zinc-600" style={{ top: i * 44 }}>
                {h}
              </span>
            ))}
          </div>
          {staff.map((s) => (
            <div key={s.name} className="relative h-[200px] rounded-md border border-white/[0.06] bg-white/[0.02]">
              {s.blocks.map((b, i) => (
                <div
                  key={i}
                  className="absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-0.5 leading-tight"
                  style={{
                    top: b.top,
                    height: b.h,
                    background:
                      b.tone === "off"
                        ? "repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0 4px,transparent 4px 8px)"
                        : b.tone === "gap"
                          ? `${accent}10`
                          : `${accent}2a`,
                    borderLeft: b.tone === "off" ? undefined : `2px solid ${b.tone === "gap" ? `${accent}55` : accent}`,
                  }}
                >
                  <p className="truncate text-[9px] font-semibold text-white">{b.who}</p>
                  <p className="truncate text-[8px] text-zinc-400">{b.what}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </BrowserFrame>
  );
}

export const BEAUTY_DIARY = [
  {
    name: "Amira",
    blocks: [
      { top: 4, h: 60, who: "Hannah P.", what: "Full colour · deposit paid" },
      { top: 66, h: 30, who: "Colour developing", what: "Free for a quick job", tone: "gap" as const },
      { top: 100, h: 40, who: "Hannah P.", what: "Cut & blow-dry" },
    ],
  },
  {
    name: "Jess",
    blocks: [
      { top: 20, h: 40, who: "Leah M.", what: "Gel manicure" },
      { top: 70, h: 44, who: "Lunch", what: "", tone: "off" as const },
      { top: 120, h: 60, who: "Priya S.", what: "Lash lift & tint" },
    ],
  },
  {
    name: "Chloe",
    blocks: [
      { top: 4, h: 34, who: "Online booking", what: "Brow shape & tint" },
      { top: 50, h: 70, who: "Rosa D.", what: "Balayage · patch-tested" },
      { top: 140, h: 40, who: "Anyone", what: "Facial" },
    ],
  },
];

export const BARBER_DIARY = [
  {
    name: "Marco",
    blocks: [
      { top: 4, h: 26, who: "Dan R.", what: "Skin fade" },
      { top: 32, h: 26, who: "Walk-in", what: "Kids cut" },
      { top: 60, h: 36, who: "Tom B.", what: "Fade + beard" },
      { top: 110, h: 26, who: "Online", what: "Scissor cut" },
    ],
  },
  {
    name: "Leon",
    blocks: [
      { top: 10, h: 26, who: "Sami K.", what: "Skin fade" },
      { top: 44, h: 44, who: "Time off", what: "", tone: "off" as const },
      { top: 100, h: 36, who: "Jay P.", what: "Hot towel shave" },
    ],
  },
  {
    name: "Ali",
    blocks: [
      { top: 4, h: 26, who: "Walk-in", what: "Buzz cut" },
      { top: 34, h: 26, who: "Chris O.", what: "Skin fade" },
      { top: 66, h: 26, who: "Anyone", what: "Beard trim" },
      { top: 130, h: 36, who: "Reece L.", what: "Fade + design" },
    ],
  },
];

// ── Salons & barbers: the online booking page ───────────────────────────────

export function BookingPageMockup({
  accent = BEAUTY,
  shop = "Glow Studio",
  service = "Cut & blow-dry",
  price = "£45",
  staff = ["Anyone", "Amira", "Jess", "Chloe"],
}: {
  accent?: string;
  shop?: string;
  service?: string;
  price?: string;
  staff?: string[];
}) {
  const slots = ["10:15", "10:45", "11:30", "13:00", "14:15", "15:45"];
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col bg-white px-3 pb-5 pt-10">
        <p className="text-center text-[13px] font-bold text-zinc-900">{shop}</p>
        <p className="text-center text-[9px] text-zinc-500">Book online · pay a small deposit</p>
        <div className="mt-3 rounded-xl border border-zinc-200 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-zinc-900">{service}</span>
            <span className="text-[11px] font-bold text-zinc-900">{price}</span>
          </div>
          <p className="text-[9px] text-zinc-500">45 min</p>
        </div>
        <p className="mt-3 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">With</p>
        <div className="mt-1 flex gap-1.5">
          {staff.map((s, i) => (
            <span
              key={s}
              className="rounded-full border px-2 py-1 text-[9px] font-semibold"
              style={i === 0 ? { background: accent, borderColor: accent, color: "#fff" } : { borderColor: "#e4e4e7", color: "#3f3f46" }}
            >
              {s}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">Saturday 18 Oct</p>
        <div className="mt-1 grid grid-cols-3 gap-1.5">
          {slots.map((t, i) => (
            <span
              key={t}
              className="rounded-lg border py-1.5 text-center text-[10px] font-semibold"
              style={i === 2 ? { background: `${accent}18`, borderColor: accent, color: "#18181b" } : { borderColor: "#e4e4e7", color: "#3f3f46" }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="mt-auto rounded-xl py-2.5 text-center text-[11px] font-bold text-white" style={{ background: accent }}>
          Confirm 11:30
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Barbers: walk-in queue on the TV by the door ────────────────────────────

export function WalkInQueueMockup() {
  const queue: { name: string; wait: string; with: string; now?: boolean }[] = [
    { name: "Ryan", wait: "In the chair", with: "Marco", now: true },
    { name: "Kofi", wait: "Up next", with: "Ali" },
    { name: "Ben", wait: "~15 min", with: "Anyone" },
    { name: "Hassan", wait: "~25 min", with: "Leon" },
    { name: "Josh", wait: "~40 min", with: "Anyone" },
  ];
  return (
    <BrowserFrame url="orderhubsolutions">
      <div className="grid grid-cols-[1.5fr_1fr] gap-3 bg-[#0a0a0a] p-4">
        <div>
          <div className="flex items-center gap-2">
            <Scissors className="h-4 w-4" style={{ color: BARBER }} />
            <span className="text-[13px] font-bold text-white">Sharp Lines · Walk-ins</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {queue.map((q, i) => (
              <div
                key={q.name}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
                style={q.now ? { background: `${BARBER}22`, border: `1px solid ${BARBER}66` } : { background: "rgba(255,255,255,0.04)" }}
              >
                <span className="w-4 text-[10px] font-bold text-zinc-500">{i + 1}</span>
                <span className="flex-1 text-[11px] font-semibold text-white">{q.name}</span>
                <span className="text-[9px] text-zinc-400">{q.with}</span>
                <span className="w-16 text-right text-[10px] font-semibold" style={{ color: q.now ? BARBER : "#d4d4d8" }}>
                  {q.wait}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl bg-white p-3 text-center">
          <div className="h-20 w-20">
            <QrGlyph />
          </div>
          <p className="mt-2 text-[10px] font-bold text-zinc-900">Join the queue</p>
          <p className="text-[8px] text-zinc-500">Watch your place live on your phone</p>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Salons & barbers: checkout with tip, product and loyalty ────────────────

export function SalonCheckoutMockup({ accent = BEAUTY }: { accent?: string }) {
  return (
    <BrowserFrame url="app.orderhub">
      <div className="p-3.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-white" style={{ background: accent }}>
            HP
          </span>
          <div>
            <p className="text-[12px] font-bold text-white">Hannah Price</p>
            <p className="text-[9px] text-zinc-500">12th visit · with Amira</p>
          </div>
          <span className="ml-auto flex items-center gap-1 text-[9px] text-amber-300">
            <Star className="h-3 w-3" /> Regular
          </span>
        </div>
        <div className="mt-3 space-y-1.5 text-[11px]">
          {[
            ["Full colour", "£85.00"],
            ["Cut & blow-dry", "£45.00"],
            ["Bond repair treatment", "£18.00"],
            ["Deposit paid online", "-£20.00"],
          ].map(([n, p]) => (
            <div key={n} className="flex justify-between text-zinc-200">
              <span>{n}</span>
              <span className="tabular-nums">{p}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Tip</p>
        <div className="mt-1 grid grid-cols-4 gap-1.5">
          {["None", "10%", "15%", "20%"].map((t, i) => (
            <span
              key={t}
              className="rounded-md border py-1 text-center text-[10px] font-semibold"
              style={i === 1 ? { background: `${accent}22`, borderColor: accent, color: "#fff" } : { borderColor: "rgba(255,255,255,0.1)", color: "#a1a1aa" }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg px-3 py-2" style={{ background: accent }}>
          <span className="text-[12px] font-bold text-white">Charge £140.80</span>
          <span className="text-[10px] font-semibold text-white/80">Card machine</span>
        </div>
      </div>
    </BrowserFrame>
  );
}

// ── Salons: reminders and rebooking ─────────────────────────────────────────

export function SalonReminderMockup({ accent = BEAUTY }: { accent?: string }) {
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col gap-2.5 bg-[#f4f4f5] px-3 pb-5 pt-10">
        {[
          { icon: <ShieldCheck className="h-3.5 w-3.5" />, title: "Booked in", body: "Sat 18 Oct, 11:30 with Amira. Change or cancel up to 24h before." },
          { icon: <Sparkles className="h-3.5 w-3.5" />, title: "See you tomorrow", body: "Reminder: Cut & blow-dry at 11:30." },
          { icon: <Star className="h-3.5 w-3.5" />, title: "How did we do?", body: "Leave us a Google review — it really helps." },
          { icon: <Users className="h-3.5 w-3.5" />, title: "Time for your next visit?", body: "It's been 6 weeks. Book again in two taps." },
        ].map((m) => (
          <div key={m.title} className="rounded-xl bg-white p-2.5 shadow-sm">
            <div className="flex items-center gap-1.5">
              <span className="grid h-5 w-5 place-items-center rounded-full text-white" style={{ background: accent }}>
                {m.icon}
              </span>
              <span className="text-[11px] font-bold text-zinc-900">{m.title}</span>
            </div>
            <p className="mt-1 text-[10px] leading-snug text-zinc-600">{m.body}</p>
          </div>
        ))}
      </div>
    </PhoneFrame>
  );
}
