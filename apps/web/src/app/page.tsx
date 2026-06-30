// Phase AP marketing — Deliverect-style landing.
//
// Stays a Server Component for fast first paint + SEO. Animated pieces
// (logo marquee, stat counters, scroll fade-in) are tiny client islands
// underneath. Login surface unchanged — every CTA points at /login
// which then routes through the existing email-password / Google /
// Apple flow into /dashboard.

import Link from "next/link";
import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { LoggedInBanner } from "@/components/marketing/logged-in-banner";
import { SiteNav } from "@/components/marketing/site-nav";
import { MarqueeLogos } from "@/components/marketing/marquee-logos";
import { StatCounters } from "@/components/marketing/stat-counters";
import { FeatureBlocks } from "@/components/marketing/feature-blocks";
import { InView } from "@/components/marketing/in-view";
import { BrandLogo } from "@/components/marketing/brand-logo";
import { ContactForm } from "@/components/marketing/contact-form";
import { WhatsAppButton } from "@/components/marketing/whatsapp-button";

export const metadata: Metadata = {
  title: "Order Hub — One inbox for every restaurant order",
  description:
    "POS, online ordering, and every delivery platform — Uber Eats, Deliveroo, HubRise — unified. Built for UK takeaways and multi-location restaurants.",
};

// Hosts that should render the marketing site (everything else is treated as
// a brand custom domain and redirected to its storefront).
const PRIMARY_HOSTS = (
  process.env.NEXT_PUBLIC_PRIMARY_HOSTS ??
  "orderhubsolutions.com,www.orderhubsolutions.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isPrimaryHost(host: string): boolean {
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".onrender.com") ||
    host.endsWith(".vercel.app") ||
    PRIMARY_HOSTS.includes(host)
  );
}

async function resolveCustomDomain(host: string): Promise<string | null> {
  const apiUrl = (
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.API_PUBLIC_URL ||
    "https://orderhub-api-0re6.onrender.com/api"
  ).replace(/\/$/, "");
  try {
    const res = await fetch(
      `${apiUrl}/v1/brands/public/resolve-host?host=${encodeURIComponent(host)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.slug && j?.brandId) {
      return `/order/${j.slug}?brand=${encodeURIComponent(j.brandId)}`;
    }
  } catch {
    /* network blip — fall through to marketing render */
  }
  return null;
}

export default async function MarketingHomePage() {
  noStore();

  // Brand custom domain (e.g. order.pizzauno.com): resolve the host → that
  // brand's storefront and redirect. Mirrors /brand/[slug] but driven by the
  // incoming Host instead of a path slug. Primary hosts render marketing.
  const host = ((await headers()).get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (!isPrimaryHost(host)) {
    const target = await resolveCustomDomain(host);
    if (target) redirect(target);
  }

  const contactWebhookUrl =
    process.env.CONTACT_WEBHOOK_URL ??
    process.env.NEXT_PUBLIC_CONTACT_WEBHOOK_URL ??
    "";

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <LoggedInBanner />
      <SiteNav />
      <Hero />
      <MarqueeLogos />
      <StatCounters />
      <FeatureBlocks />
      <CaseStudy />
      <Contact webhookUrl={contactWebhookUrl} />
      <FinalCta />
      <SiteFooter />
      <WhatsAppButton />
    </div>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-zinc-100">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.07]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 15% 25%, #10b981 0, transparent 35%), radial-gradient(circle at 85% 60%, #f97316 0, transparent 40%)",
        }}
      />
      <div className="mx-auto max-w-6xl px-4 pt-20 pb-24 text-center sm:pt-28 sm:pb-32">
        <InView>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Built for UK takeaways &amp; multi-location restaurants
          </span>
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
            One inbox for{" "}
            <span className="bg-gradient-to-r from-emerald-600 to-orange-500 bg-clip-text text-transparent">
              every order
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-zinc-600 sm:text-lg">
            POS, online ordering, and every delivery platform unified into a
            single Order Hub. Stop juggling five tablets at the kitchen pass.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Get started
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="mailto:hello@orderhub.io"
              className="rounded-lg border border-zinc-200 bg-white px-5 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              Talk to sales
            </a>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            No credit card required · Cancel anytime
          </p>
        </InView>
      </div>
    </section>
  );
}

// ── Case study spotlight ─────────────────────────────────────────────────────

function CaseStudy() {
  return (
    <section className="border-y border-zinc-100 bg-zinc-50 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <InView>
          <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 text-white shadow-xl">
            <div className="grid lg:grid-cols-[1.3fr,1fr]">
              <div className="p-10 sm:p-14">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                  Built around real takeaway operations
                </p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                  Pizza Uno Pelton runs every order through Order Hub
                </h2>
                <p className="mt-4 max-w-xl text-zinc-300 leading-relaxed">
                  Every walk-in, every Deliveroo ticket, every direct online
                  order lands in the same Orders board and prints from the
                  same kitchen printer. The cashier never touches a tablet.
                </p>
                <div className="mt-6 flex flex-wrap gap-4 text-sm">
                  <Metric label="Channels unified" value="5" />
                  <Metric label="Reduction in printer juggling" value="100%" />
                  <Metric label="Time to first order" value="< 1hr" />
                </div>
                <p className="mt-6 text-xs italic text-zinc-400">
                  Case study expanded soon. Currently in pilot.
                </p>
              </div>
              <div className="relative hidden lg:block bg-gradient-to-bl from-orange-500/20 via-transparent to-emerald-500/10">
                <div className="absolute inset-0 grid place-items-center">
                  <div className="flex flex-col gap-3">
                    <BrandLogo brand="ubereats" size={56} rounded />
                    <BrandLogo brand="deliveroo" size={56} rounded />
                    <BrandLogo brand="orderhub" size={56} rounded />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </InView>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xl font-bold text-emerald-400">{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-zinc-400">
        {label}
      </p>
    </div>
  );
}

// ── Contact section ─────────────────────────────────────────────────────────
//
// Replaces the previous static "Talk to us" card. The ContactForm
// component POSTs straight to a Google Sheet via Apps Script — see
// MARKETING_GOOGLE_SHEET.md for the operator setup steps. The pricing
// anchor stays valid (#pricing) so the nav link still scrolls here.

function Contact({ webhookUrl }: { webhookUrl: string }) {
  return (
    <section id="pricing" className="bg-zinc-50 py-24">
      <div className="mx-auto max-w-5xl px-4">
        <ContactForm webhookUrl={webhookUrl} />
      </div>
    </section>
  );
}

// ── Pricing teaser (kept as a no-op for now in case anything links here) ──
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _UnusedPricing() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-3xl px-4">
        <InView>
          <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">
              Pricing
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Talk to us
            </h2>
            <p className="mt-4 text-zinc-600">
              We&apos;re onboarding the first batch of independent UK takeaways
              with bespoke pricing while we shape long-term plans. Drop us a
              line and we&apos;ll come back with what makes sense for your
              setup.
            </p>
            <a
              href="mailto:hello@orderhub.io"
              className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              hello@orderhub.io
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </InView>
      </div>
    </section>
  );
}

// ── Final CTA ────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 py-20 text-center text-white">
      <div className="mx-auto max-w-3xl px-4">
        <InView>
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
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600"
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
        </InView>
      </div>
    </section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

function SiteFooter() {
  return (
    <footer className="border-t border-zinc-100 bg-white py-14">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Link href="/" className="flex items-center gap-2">
              {/* Same real logo as the header — sourced from
                  apps/web/public/orderhub-logo.png. */}
              <img
                src="/orderhub-logo.png"
                alt="Order Hub"
                width={36}
                height={36}
                className="h-9 w-9 object-contain"
              />
              <span className="font-bold tracking-tight">Order Hub</span>
            </Link>
            <p className="mt-3 text-sm text-zinc-500">
              Omnichannel order management for restaurants and takeaways.
            </p>
          </div>
          <FooterCol
            heading="Solutions"
            items={[
              { label: "POS", href: "/login" },
              { label: "Direct online ordering", href: "/login" },
              { label: "Menu Manager", href: "/login" },
              { label: "Live order tracking", href: "/login" },
            ]}
          />
          <FooterCol
            heading="Integrations"
            items={[
              { label: "Uber Eats", href: "/login" },
              { label: "Deliveroo", href: "/login" },
              { label: "HubRise", href: "/login" },
              { label: "Just Eat (coming soon)", href: "/login" },
              { label: "Stripe", href: "/login" },
            ]}
          />
          <FooterCol
            heading="Order Hub"
            items={[
              { label: "Features", href: "/#features" },
              { label: "How it works", href: "/#how" },
              { label: "Pricing", href: "/#pricing" },
              { label: "Contact sales", href: "mailto:hello@orderhub.io" },
              { label: "Log in", href: "/login" },
            ]}
          />
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-zinc-100 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center">
          <p>
            © {new Date().getFullYear()} Order Hub Solutions. All rights
            reserved.
          </p>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="hover:text-zinc-900">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-zinc-900">
              Privacy
            </Link>
            <a href="#" className="hover:text-zinc-900">
              Security
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  heading,
  items,
}: {
  heading: string;
  items: Array<{ label: string; href: string }>;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {heading}
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.label}>
            <Link href={it.href} className="text-sm text-zinc-700 hover:text-zinc-900">
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
