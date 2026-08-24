"use client";

// The storefront's Home tab — the shop's front page.
//
// Built the way the McDonald's and Nando's apps build theirs: a stack of promo
// CARDS, each one a picture, a short headline and a single button, with its
// small print underneath. Not a page of prose. Somebody opening a takeaway app
// is deciding what to eat, and a paragraph about the business is the one thing
// on the screen that cannot answer that.
//
// Everything on it is the shop's own — its photography, its offers, its hours.
// The only OrderHub mark is one line at the very bottom, which is where a
// white-labelled product's badge belongs.
//
// It is deliberately NOT the default route. Every QR code and printed link
// points at /order/<slug>, and someone scanning a code at a table wants the
// menu, not an advert.
//
// The motion is one staged entrance and then stillness. A page that keeps
// moving while somebody reads opening hours is harder to read, not livelier.
// All of it collapses under prefers-reduced-motion.

import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import Link from "next/link";
import { ArrowRight, Clock, MapPin, Phone } from "lucide-react";
import { formatMoney } from "@orderhub/shared";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";
import { ReferAFriend } from "@/components/storefront/refer-a-friend";
import { useCustomerAuth } from "@/hooks/use-customer-auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export default function StorefrontHomePage() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const slug = String(params.slug);
  const brandId = search.get("brand");

  // Same key and shape as the menu tab, so moving between tabs reuses the
  // cached payload rather than refetching a menu they just looked at.
  const { data } = useQuery({
    queryKey: ["storefront", slug, brandId],
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/ordering/store/${slug}`, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data),
  });

  const { token: customerToken } = useCustomerAuth();
  const brand = (data as any)?.brand;
  const location = (data as any)?.location;
  const menu = (data as any)?.menu;
  const closed = (data as any)?.closed;
  const currency = location?.currency ?? "GBP";
  const topSellers = ((data as any)?.topSellers ?? []) as Array<{
    id: string;
    name: string;
    basePrice: number;
    imageUrl?: string | null;
    description?: string | null;
  }>;

  const hero = menu?.heroImage || menu?.bannerImage || null;
  const menuHref = `/order/${encodeURIComponent(slug)}${brandId ? `?brand=${brandId}` : ""}`;

  // Only offers that are genuinely running. An empty rail beats an invented
  // one, and a promise on this page is a promise at the till.
  const campaign = (data as any)?.campaign;
  const offers: Array<{ title: string; sub?: string }> = [];
  if (campaign?.name) {
    offers.push({
      title: campaign.name,
      sub: campaign.description ?? undefined,
    });
  }
  if ((data as any)?.freeDelivery) {
    offers.push({ title: "Free delivery", sub: "On orders right now" });
  }
  if ((data as any)?.bogo) {
    offers.push({ title: "Buy one, get one free", sub: "On selected items" });
  }
  if ((data as any)?.freeItem?.name) {
    offers.push({
      title: `Free ${(data as any).freeItem.name}`,
      sub: "With your order",
    });
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-zinc-50">
      <style jsx global>{`
        @keyframes oh-rise {
          from {
            opacity: 0;
            transform: translateY(16px);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        .oh-rise {
          animation: oh-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes oh-drift {
          from {
            transform: scale(1.07);
          }
          to {
            transform: scale(1);
          }
        }
        .oh-drift {
          animation: oh-drift 1.5s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .oh-rise,
          .oh-drift {
            animation: none !important;
          }
        }
      `}</style>

      {/* ── Brand bar ────────────────────────────────────────────────── */}
      <header className="flex items-center justify-center gap-2 bg-white px-4 py-3">
        {brand?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brand.logoUrl}
            alt={brand?.name ?? ""}
            className="h-8 w-auto max-w-[160px] object-contain"
          />
        ) : (
          <span className="text-base font-black tracking-tight text-zinc-900">
            {brand?.name ?? location?.name ?? ""}
          </span>
        )}
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="oh-rise relative overflow-hidden bg-zinc-900">
        <div className="relative h-[38vh] min-h-[240px]">
          {hero ? (
            <div className="oh-drift absolute inset-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={hero} alt="" className="h-full w-full object-cover" />
            </div>
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-black/10" />
          <div className="absolute inset-x-0 bottom-0 p-5">
            <h1 className="text-[32px] font-black leading-[1.05] tracking-tight text-white">
              {closed ? "Have a look" : "Hungry?"}
            </h1>
            <p className="mt-1 text-lg font-bold text-white/90">
              {closed ? "We're closed right now" : "Let's fix that"}
            </p>
            <Link
              href={menuHref}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-[15px] font-bold text-zinc-900 shadow-lg transition active:scale-[0.97]"
            >
              {closed ? "See the menu" : "Start an order"}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Offers ───────────────────────────────────────────────────── */}
      {offers.length > 0 ? (
        <Section title="Offers" delay={80}>
          <div className="space-y-3">
            {offers.map((o) => (
              <Link
                key={o.title}
                href={menuHref}
                className="block overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 p-5 shadow-sm transition active:scale-[0.99]"
              >
                <p className="text-[22px] font-black leading-tight text-white">
                  {o.title}
                </p>
                {o.sub ? (
                  <p className="mt-0.5 text-sm font-semibold text-white/90">
                    {o.sub}
                  </p>
                ) : null}
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-bold text-zinc-900">
                  Order now
                </span>
              </Link>
            ))}
          </div>
          {/* The small print sits under the card, as it does in every
              marketplace app — it belongs to the offer, not to the page. */}
          <p className="mt-2 px-1 text-[11px] leading-snug text-zinc-400">
            Subject to availability. Fees apply to delivery orders.
          </p>
        </Section>
      ) : null}

      {/* ── What's on ────────────────────────────────────────────────── */}
      {topSellers.length > 0 ? (
        <Section title="What's on" delay={140}>
          <div className="space-y-3">
            {topSellers.slice(0, 6).map((item) => (
              <Link
                key={item.id}
                href={menuHref}
                className="flex overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition active:scale-[0.99]"
              >
                <div className="flex min-w-0 flex-1 flex-col justify-center p-4">
                  <p className="text-[19px] font-black leading-tight text-zinc-900">
                    {item.name}
                  </p>
                  <p className="mt-0.5 text-sm font-bold text-zinc-500">
                    {formatMoney(Number(item.basePrice), currency)}
                  </p>
                  <span className="mt-3 inline-flex w-fit items-center rounded-lg bg-zinc-900 px-4 py-2 text-[13px] font-bold text-white">
                    Order now
                  </span>
                </div>
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-[132px] w-[132px] shrink-0 object-cover"
                  />
                ) : null}
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {/* ── The shop itself ──────────────────────────────────────────── */}
      <Section title="Find us" delay={200}>
        <div className="space-y-0.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <Row icon={Clock}>
            {closed
              ? "Closed right now"
              : `Ready in about ${location?.currentPrepTime ?? 20} minutes`}
          </Row>
          {location?.addressLine1 || location?.postcode ? (
            <Row icon={MapPin}>
              {[location?.addressLine1, location?.city, location?.postcode]
                .filter(Boolean)
                .join(", ")}
            </Row>
          ) : null}
          {location?.phone ? (
            <a
              href={`tel:${location.phone}`}
              className="flex items-center gap-3 py-2 text-sm font-semibold text-zinc-900"
            >
              <Phone className="h-4 w-4 shrink-0 text-zinc-400" />
              {location.phone}
            </a>
          ) : null}
        </div>
      </Section>

      <section className="px-4 pt-6">
        <ReferAFriend
          locationId={location?.id}
          brandName={brand?.name ?? location?.name}
          shareUrl={
            typeof window !== "undefined"
              ? `${window.location.origin}/order/${encodeURIComponent(slug)}${brandId ? `?brand=${brandId}` : ""}`
              : ""
          }
          currency={currency}
          token={customerToken}
        />
      </section>

      <footer className="px-4 pb-8 pt-6 text-center">
        <a
          href="https://www.orderhubsolutions.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-medium tracking-wide text-zinc-400 transition hover:text-zinc-600"
        >
          Powered by <span className="font-bold text-zinc-500">Order Hub</span>
        </a>
      </footer>

      <StorefrontTabBar slug={slug} brandId={brandId} />
    </main>
  );
}

function Section({
  title,
  delay,
  children,
}: {
  title: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="oh-rise px-4 pt-6"
      style={{ animationDelay: `${delay}ms` }}
    >
      <h2 className="mb-3 text-[26px] font-black tracking-tight text-zinc-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({
  icon: Icon,
  children,
}: {
  icon: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-3 py-2 text-sm text-zinc-600">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
      <span>{children}</span>
    </p>
  );
}
