"use client";

// The storefront's Home tab — the shop's own front page.
//
// Everything here is the shop's, not ours: its photography, its offers, its
// hours. The only OrderHub mark is the line at the very bottom, which is where
// a white-labelled product's badge belongs.
//
// It is deliberately NOT the default route. Every QR code and printed link
// points at /order/<slug>, and someone scanning a code at a table wants the
// menu — landing them on an advert would add a tap to every order.
//
// The motion is staged rather than scattered: one entrance sequence on load,
// then nothing moves unless the customer does. A page that keeps animating
// while someone is reading opening hours is a page that is harder to read.
// All of it collapses under prefers-reduced-motion.

import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Clock, MapPin, Phone, ArrowRight, Star } from "lucide-react";
import axios from "axios";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";
import { formatMoney } from "@orderhub/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export default function StorefrontHomePage() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const slug = params.slug;
  const brandId = search.get("brand");

  // Same key and same shape as the menu tab, so moving between tabs reuses
  // the cached payload rather than refetching a menu the customer just saw.
  const { data, isLoading } = useQuery({
    queryKey: ["storefront", slug, brandId],
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/ordering/store/${slug}`, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data),
  });

  const brand = (data as any)?.brand;
  const location = (data as any)?.location;
  const menu = (data as any)?.menu;
  const topSellers = ((data as any)?.topSellers ?? []) as Array<{
    id: string;
    name: string;
    basePrice: number;
    imageUrl?: string | null;
  }>;
  const currency = location?.currency ?? "GBP";
  const closed = (data as any)?.closed;

  const hero = menu?.heroImage || menu?.bannerImage || null;
  const menuHref = `/order/${encodeURIComponent(slug)}${brandId ? `?brand=${brandId}` : ""}`;

  // Live offers, in the shop's own words. Only what is actually running —
  // an empty rail is better than an invented one.
  const offers: string[] = [];
  const campaign = (data as any)?.campaign;
  if (campaign?.name) offers.push(campaign.name);
  if ((data as any)?.freeDelivery) offers.push("Free delivery");
  if ((data as any)?.bogo) offers.push("Buy one get one free");
  if ((data as any)?.freeItem?.name) offers.push(`Free ${(data as any).freeItem.name}`);

  return (
    <main className="min-h-screen overflow-x-hidden bg-white pb-2">
      <style jsx global>{`
        @keyframes oh-rise {
          from {
            opacity: 0;
            transform: translateY(14px);
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
            transform: scale(1.08);
          }
          to {
            transform: scale(1);
          }
        }
        .oh-drift {
          animation: oh-drift 1.6s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .oh-rise,
          .oh-drift {
            animation: none !important;
          }
        }
      `}</style>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative h-[46vh] min-h-[280px] w-full overflow-hidden bg-zinc-900">
        {/* Plain <img>, like the rest of the storefront. next/image needs
            every host whitelisted in next.config, and menu photography lives
            wherever the operator put it — Supabase today, anywhere tomorrow.
            An allow-list cannot keep up, and the failure mode is a
            broken-image icon on a shop's own front page. */}
        {hero && (
          <div className="oh-drift absolute inset-0">
            <img src={hero} alt="" className="h-full w-full object-cover" />
          </div>
        )}
        {/* A scrim, not a tint: the shop's photo stays the photo, and the
            type on top stays readable whatever they uploaded. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/10" />

        <div className="absolute inset-x-0 bottom-0 p-5">
          {brand?.logoUrl && (
            <div className="oh-rise mb-3 h-16 w-16 overflow-hidden rounded-2xl bg-white p-1 shadow-lg">
              <img
                src={brand.logoUrl}
                alt=""
                className="h-full w-full rounded-xl object-contain"
              />
            </div>
          )}
          <h1
            className="oh-rise text-3xl font-black leading-tight tracking-tight text-white"
            style={{ animationDelay: "60ms" }}
          >
            {brand?.name ?? location?.name ?? " "}
          </h1>
          {location?.city || location?.addressLine1 ? (
            <p
              className="oh-rise mt-1 flex items-center gap-1.5 text-sm text-white/80"
              style={{ animationDelay: "120ms" }}
            >
              <MapPin className="h-3.5 w-3.5" />
              {[location?.addressLine1, location?.city].filter(Boolean).join(", ")}
            </p>
          ) : null}

          <Link
            href={menuHref}
            className="oh-rise mt-4 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-bold text-zinc-900 shadow-xl transition active:scale-[0.97]"
            style={{ animationDelay: "180ms" }}
          >
            {closed ? "See the menu" : "Order now"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Offers ───────────────────────────────────────────────────── */}
      {offers.length > 0 && (
        <section className="oh-rise px-4 pt-5" style={{ animationDelay: "240ms" }}>
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {offers.map((o) => (
              <span
                key={o}
                className="whitespace-nowrap rounded-full bg-amber-100 px-3.5 py-2 text-xs font-bold text-amber-900"
              >
                {o}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── Popular ──────────────────────────────────────────────────── */}
      {topSellers.length > 0 && (
        <section className="oh-rise px-4 pt-6" style={{ animationDelay: "300ms" }}>
          <h2 className="flex items-center gap-2 text-lg font-black tracking-tight text-zinc-900">
            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            Popular right now
          </h2>
          <div className="mt-3 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {topSellers.slice(0, 8).map((item) => (
              <Link
                key={item.id}
                href={menuHref}
                className="w-36 shrink-0 transition active:scale-[0.97]"
              >
                <div className="relative h-28 w-36 overflow-hidden rounded-xl bg-zinc-100">
                  {item.imageUrl && (
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <p className="mt-1.5 line-clamp-2 text-[13px] font-semibold leading-snug text-zinc-900">
                  {item.name}
                </p>
                <p className="text-[13px] font-bold text-zinc-500">
                  {formatMoney(Number(item.basePrice), currency)}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ── About + practicalities ───────────────────────────────────── */}
      <section className="oh-rise px-4 pt-7" style={{ animationDelay: "360ms" }}>
        {/* overflow-wrap:anywhere because this is operator-written text and
            theirs contains a bare ordering URL. One unbreakable word widens
            the whole document, and on mobile a horizontally-scrolling page
            stretches the fixed tab bar with it and carries the last tab past
            the edge of the screen. */}
        {(brand?.about || location?.about) && (
          <p className="text-[15px] leading-relaxed text-zinc-600 [overflow-wrap:anywhere]">
            {brand?.about ?? location?.about}
          </p>
        )}
        <div className="mt-4 space-y-2.5 rounded-2xl bg-zinc-50 p-4">
          {location?.phone && (
            <a
              href={`tel:${location.phone}`}
              className="flex items-center gap-3 text-sm font-medium text-zinc-800"
            >
              <Phone className="h-4 w-4 text-zinc-400" />
              {location.phone}
            </a>
          )}
          <p className="flex items-center gap-3 text-sm text-zinc-600">
            <Clock className="h-4 w-4 text-zinc-400" />
            {closed ? "Closed right now" : `Ready in about ${location?.currentPrepTime ?? 20} minutes`}
          </p>
          {(location?.addressLine1 || location?.postcode) && (
            <p className="flex items-start gap-3 text-sm text-zinc-600">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
              {[location?.addressLine1, location?.city, location?.postcode]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
        </div>
      </section>

      {/* ── Our mark, and only here ──────────────────────────────────── */}
      <footer className="px-4 pb-6 pt-8 text-center">
        <a
          href="https://www.orderhubsolutions.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-medium tracking-wide text-zinc-400 transition hover:text-zinc-600"
        >
          Powered by <span className="font-bold text-zinc-500">Order Hub</span>
        </a>
      </footer>

      {isLoading && <div className="sr-only">Loading</div>}

      <StorefrontTabBar slug={slug} brandId={brandId} />
    </main>
  );
}
