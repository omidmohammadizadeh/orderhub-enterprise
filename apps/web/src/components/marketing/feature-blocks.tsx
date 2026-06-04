// Phase AP marketing — four alternating image/text feature sections.
//
// Image side is a styled placeholder card with platform logos floating
// inside (since we don't have product screenshots yet). Once you have
// real POS / storefront / menu manager / tracker screenshots, replace
// the per-block `mockup` render with an <Image src=... /> and the
// layout stays identical.

import { InView } from "./in-view";
import { BrandLogo } from "./brand-logo";
import {
  ShoppingBag,
  Globe,
  UtensilsCrossed,
  Activity,
  Bike,
  Banknote,
} from "lucide-react";

interface Feature {
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  mockup: React.ReactNode;
}

const FEATURES: Feature[] = [
  {
    eyebrow: "POS",
    title: "Every channel into one till",
    body: "Walk-in, phone, online, every marketplace — all into the same Orders board and the same printer queue. Stop juggling tablets.",
    bullets: [
      "Modifier groups + multi-SKU products",
      "Postcode-based delivery fees",
      "Quick promos + free delivery",
    ],
    mockup: <MockupPosBoard />,
  },
  {
    eyebrow: "Direct online ordering",
    title: "Your storefront, your margin",
    body: "Customers order direct from your own branded URL — keep 100% of the basket instead of paying 30% to a marketplace.",
    bullets: [
      "Custom domain per location",
      "Live order tracking page",
      "Schedule ahead up to 7 days",
    ],
    mockup: <MockupStorefront />,
  },
  {
    eyebrow: "Menu Manager",
    title: "Build once, publish everywhere",
    body: "Centralised catalog with PLUs, modifier groups, variants. Push to POS, your storefront, or any marketplace channel — same data, no duplication.",
    bullets: [
      "Categories with drag-drop reordering",
      "Image uploader with crop",
      "Per-platform price overrides",
    ],
    mockup: <MockupMenu />,
  },
  {
    eyebrow: "Live tracking",
    title: "Customers see what your kitchen sees",
    body: "Accepted → Preparing → Ready → Out for delivery → Delivered. Every milestone the staff hits on the POS shows up instantly on the customer's tracking page.",
    bullets: [
      "Real-time status push",
      "Cancellation reasons surfaced",
      "Auto-shows estimated ready time",
    ],
    mockup: <MockupTracker />,
  },
];

export function FeatureBlocks() {
  return (
    <section id="features" className="bg-white py-24">
      <div className="mx-auto max-w-6xl px-4 space-y-24">
        {FEATURES.map((f, idx) => (
          <InView key={f.title}>
            <div
              className={`grid items-center gap-10 lg:grid-cols-2 ${
                idx % 2 === 1 ? "lg:[&>div:first-child]:order-2" : ""
              }`}
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">
                  {f.eyebrow}
                </p>
                <h2 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
                  {f.title}
                </h2>
                <p className="mt-4 text-zinc-600 leading-relaxed">{f.body}</p>
                <ul className="mt-5 space-y-2">
                  {f.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-2 text-sm text-zinc-700"
                    >
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="relative">
                <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-br from-emerald-100/40 via-transparent to-orange-100/40 blur-2xl" />
                {f.mockup}
              </div>
            </div>
          </InView>
        ))}
      </div>
    </section>
  );
}

// ── Placeholder mockups ─────────────────────────────────────────────────────
// Pure-CSS / SVG illustrations until real product screenshots are dropped in.

function MockupCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
      </div>
      {children}
    </div>
  );
}

function MockupPosBoard() {
  const cols = [
    { name: "New", n: 3, color: "bg-orange-50 text-orange-700" },
    { name: "Preparing", n: 2, color: "bg-blue-50 text-blue-700" },
    { name: "Ready", n: 1, color: "bg-emerald-50 text-emerald-700" },
  ];
  return (
    <MockupCard>
      <div className="grid grid-cols-3 gap-2 p-3">
        {cols.map((c) => (
          <div key={c.name}>
            <div className={`mb-2 rounded px-2 py-1 text-[10px] font-semibold ${c.color}`}>
              {c.name} · {c.n}
            </div>
            {Array.from({ length: c.n }).map((_, i) => (
              <div
                key={i}
                className="mb-1.5 rounded-md border border-zinc-200 bg-white p-2"
              >
                <div className="flex items-center gap-1">
                  <BrandLogo
                    brand={
                      i === 0 ? "ubereats" : i === 1 ? "deliveroo" : "orderhub"
                    }
                    size={14}
                    rounded
                  />
                  <span className="text-[10px] font-mono font-bold text-zinc-900">
                    #{1000 + i}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-2/3 rounded bg-zinc-100" />
                <div className="mt-1 h-1.5 w-1/2 rounded bg-zinc-100" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </MockupCard>
  );
}

function MockupStorefront() {
  return (
    <MockupCard>
      <div className="relative">
        <div className="h-20 bg-gradient-to-br from-orange-200 via-orange-300 to-orange-400" />
        <div className="absolute -bottom-3 left-3 grid h-10 w-10 place-items-center rounded-lg bg-white shadow-md ring-2 ring-white">
          <Bike className="h-5 w-5 text-orange-500" />
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3 pt-5">
        <div className="h-3 w-2/3 rounded bg-zinc-200" />
        <div className="h-2 w-1/2 rounded bg-zinc-100" />
        <div className="mt-3 flex gap-2">
          <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[10px] font-semibold text-white">
            Delivery
          </span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600">
            Pickup
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded border border-zinc-200 p-1.5">
              <div className="aspect-square rounded bg-zinc-100" />
              <div className="mt-1 h-1.5 w-2/3 rounded bg-zinc-200" />
              <div className="mt-0.5 h-1.5 w-1/3 rounded bg-emerald-200" />
            </div>
          ))}
        </div>
      </div>
    </MockupCard>
  );
}

function MockupMenu() {
  return (
    <MockupCard>
      <div className="grid grid-cols-[1fr,1.5fr] gap-3 p-3">
        <div className="space-y-1.5">
          {["Pizza", "Burgers", "Sides", "Drinks"].map((c, i) => (
            <div
              key={c}
              className={`rounded px-2 py-1.5 text-[10px] font-semibold ${
                i === 0
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-200 bg-white text-zinc-600"
              }`}
            >
              {c}
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded border border-zinc-200 bg-white p-1.5"
            >
              <div className="h-8 w-8 flex-shrink-0 rounded bg-orange-100" />
              <div className="flex-1">
                <div className="h-1.5 w-3/4 rounded bg-zinc-200" />
                <div className="mt-1 h-1.5 w-1/3 rounded bg-emerald-200" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </MockupCard>
  );
}

function MockupTracker() {
  const steps = [
    { label: "Order received", done: true },
    { label: "Confirmed", done: true },
    { label: "Preparing", done: true, active: true },
    { label: "Out for delivery", done: false },
    { label: "Delivered", done: false },
  ];
  return (
    <MockupCard>
      <div className="px-4 py-5">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100">
            <Activity className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <p className="text-xs font-bold text-zinc-900">Order accepted</p>
            <p className="text-[10px] text-zinc-500">
              #1234 · est. ready in 18 min
            </p>
          </div>
        </div>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.label} className="relative flex items-center gap-2">
              {i < steps.length - 1 && (
                <span
                  className={`absolute left-[7px] top-4 h-3 w-0.5 ${
                    s.done ? "bg-emerald-300" : "bg-zinc-200"
                  }`}
                />
              )}
              <span
                className={`relative grid h-4 w-4 place-items-center rounded-full text-[8px] font-bold ${
                  s.done
                    ? s.active
                      ? "bg-emerald-500 text-white ring-2 ring-emerald-100"
                      : "bg-emerald-500 text-white"
                    : "bg-zinc-200 text-zinc-400"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[10px] ${
                  s.done ? "font-semibold text-zinc-900" : "text-zinc-400"
                }`}
              >
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </MockupCard>
  );
}
