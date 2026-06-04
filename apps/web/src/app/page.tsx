// Phase AP — Deliverect-style marketing landing.
//
// Replaces the old root redirect. Same domain, same auth surface —
// click Login on this page lands on /login, which on success lands
// on /dashboard. Anyone already logged in is gently nudged into the
// dashboard via the small inline component at the top of the page.

import Link from "next/link";
import type { Metadata } from "next";
import { LoggedInBanner } from "@/components/marketing/logged-in-banner";

export const metadata: Metadata = {
  title: "Order Hub Solutions — One inbox for every restaurant order",
  description:
    "POS, online ordering, and every delivery platform — Just Eat, Uber Eats, Deliveroo, HubRise — in one Order Hub. Built for UK takeaways and multi-location restaurants.",
};

export default function MarketingHomePage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <LoggedInBanner />
      <SiteNav />
      <Hero />
      <LogoStrip />
      <Features />
      <HowItWorks />
      <PricingTeaser />
      <CallToAction />
      <Footer />
    </div>
  );
}

// ── Top navigation ───────────────────────────────────────────────────────────

function SiteNav() {
  return (
    <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-zinc-100">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-orange-500 text-sm font-bold text-white">
            OH
          </span>
          <span className="font-bold tracking-tight">Order Hub</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-zinc-600 sm:flex">
          <a href="#features" className="hover:text-zinc-900">
            Features
          </a>
          <a href="#how" className="hover:text-zinc-900">
            How it works
          </a>
          <a href="#pricing" className="hover:text-zinc-900">
            Pricing
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="absolute inset-0 -z-10 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, #f97316 0, transparent 35%), radial-gradient(circle at 80% 60%, #7c3aed 0, transparent 40%)",
        }}
      />
      <div className="mx-auto max-w-6xl px-4 pt-16 pb-20 sm:pt-24 sm:pb-32 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Made for UK takeaways
        </span>
        <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
          One inbox for{" "}
          <span className="bg-gradient-to-r from-orange-500 to-violet-600 bg-clip-text text-transparent">
            every order
          </span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-zinc-600 sm:text-lg">
          POS, online ordering, and every delivery platform — Just Eat,
          Uber Eats, Deliveroo, HubRise — in one Order Hub. Built for
          takeaways and multi-location restaurants who are tired of
          juggling tablets.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            Start free trial
          </Link>
          <a
            href="#features"
            className="rounded-lg border border-zinc-200 bg-white px-5 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            See features
          </a>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          No credit card required · Cancel anytime
        </p>
      </div>
    </section>
  );
}

// ── Marketplace logo strip ───────────────────────────────────────────────────

function LogoStrip() {
  const platforms = [
    "Just Eat",
    "Uber Eats",
    "Deliveroo",
    "HubRise",
    "Stripe",
    "Stuart",
  ];
  return (
    <section className="border-y border-zinc-100 bg-zinc-50/50 py-8">
      <div className="mx-auto max-w-6xl px-4 text-center">
        <p className="mb-5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Connects to the platforms you already use
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-semibold text-zinc-400">
          {platforms.map((p) => (
            <span key={p} className="opacity-70">
              {p}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Features grid ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: "One POS for every channel",
    body: "Walk-in, phone, online, and every delivery app land in the same till and the same printer. No more 5-tablet juggling.",
  },
  {
    title: "Direct online ordering",
    body: "Your own customer-facing site at order.yourshop.com — keeps 100% of the margin instead of paying 30% per platform.",
  },
  {
    title: "Centralised menu manager",
    body: "Update prices and availability once, propagate to every channel. PLU-aware, multi-SKU, modifier groups built in.",
  },
  {
    title: "Live order tracking for customers",
    body: "Accepted → Preparing → Out for delivery → Delivered. The customer sees what your staff sees, in real time.",
  },
  {
    title: "Per-location everything",
    body: "Menus, opening hours, brands, delivery zones, promos, prep times — every setting is scoped to the location it belongs to.",
  },
  {
    title: "Encrypted secrets vault",
    body: "Stripe, Google, getaddress, Supabase keys all stored under AES-256-GCM, never in plain env vars. Admin-only with password re-auth.",
  },
];

function Features() {
  return (
    <section id="features" className="py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Everything you need to run a modern takeaway
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-zinc-600">
            One unified platform — not a stack of half-integrated tools.
          </p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className="rounded-xl border border-zinc-200 bg-white p-5 hover:shadow-sm transition-shadow"
            >
              <h3 className="font-semibold text-zinc-900">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
                {f.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── How it works ─────────────────────────────────────────────────────────────

const STEPS = [
  {
    n: "1",
    title: "Connect your accounts",
    body: "Plug in Just Eat, Uber Eats, Deliveroo, Stripe, and your printer — five minutes each.",
  },
  {
    n: "2",
    title: "Build your menu once",
    body: "Categories, products, modifier groups, prices. Publish to POS, your storefront, and every marketplace.",
  },
  {
    n: "3",
    title: "Take orders",
    body: "Every channel lands in the same Orders board. Same accept-prep-ready-out flow. Same printer ticket.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="bg-zinc-50 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Live in an afternoon
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-zinc-600">
            No agency required. Three steps, no surprises.
          </p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="relative rounded-xl border border-zinc-200 bg-white p-6"
            >
              <div className="absolute -top-3 left-6 grid h-7 w-7 place-items-center rounded-full bg-orange-500 text-xs font-bold text-white shadow">
                {s.n}
              </div>
              <h3 className="mt-2 font-semibold text-zinc-900">{s.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Pricing teaser ───────────────────────────────────────────────────────────

function PricingTeaser() {
  return (
    <section id="pricing" className="py-20">
      <div className="mx-auto max-w-3xl rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
          Founding-customer pricing
        </p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">
          Simple. Per location. No setup fees.
        </h2>
        <p className="mt-3 text-zinc-600">
          Talk to us — pricing is bespoke while we onboard the first batch
          of independent takeaways. Email{" "}
          <a
            className="underline hover:text-zinc-900"
            href="mailto:hello@orderhub.io"
          >
            hello@orderhub.io
          </a>
          .
        </p>
      </div>
    </section>
  );
}

// ── CTA ─────────────────────────────────────────────────────────────────────

function CallToAction() {
  return (
    <section className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 py-20 text-center text-white">
      <div className="mx-auto max-w-3xl px-4">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Ready when you are
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-zinc-300">
          Sign in to get started. If you don&apos;t have an account yet,
          we&apos;ll create one for you on the first sign-in.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-white/20 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
          >
            Get started
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-zinc-100 bg-white py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-zinc-500 sm:flex-row">
        <p>© {new Date().getFullYear()} Order Hub Solutions. All rights reserved.</p>
        <div className="flex items-center gap-5">
          <a href="#features" className="hover:text-zinc-900">
            Features
          </a>
          <a href="#pricing" className="hover:text-zinc-900">
            Pricing
          </a>
          <Link href="/login" className="hover:text-zinc-900">
            Log in
          </Link>
        </div>
      </div>
    </footer>
  );
}
