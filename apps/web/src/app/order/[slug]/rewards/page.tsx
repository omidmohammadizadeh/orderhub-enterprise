"use client";

// The loyalty card — and the ONLY place the offer appears.
//
// Not on the menu, not on the home page, not as a banner. A stamp card
// belongs to the customer who signed in for it; putting "collect 6, get one
// free" on the public storefront turns it into an advert everyone sees and
// nobody owns, and it stops being a reason to come back.
//
// The animation is doing a job rather than decorating. A stamp landing is the
// only moment in an ordering app that is purely good news, so it gets the one
// piece of real motion in the product: the newest stamp drops in and settles,
// the rest are already there. When the card completes, the whole thing turns
// over. Nothing loops — it plays once on arrival and then holds still, and it
// all collapses under prefers-reduced-motion.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import Image from "next/image";
import { Heart, Lock, Sparkles, Ticket } from "lucide-react";
import { formatMoney } from "@orderhub/shared";
import { useCustomerAuth } from "@/hooks/use-customer-auth";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface CardState {
  active: boolean;
  stampsRequired?: number;
  stamps?: number;
  lifetimeStamps?: number;
  minimumSpend?: number | null;
  rewardLabel?: string;
  rewardItem?: { id: string; name: string; imageUrl?: string | null } | null;
  rewards?: Array<{ id: string; label: string; earnedAt: string; expiresAt: string | null }>;
}

export default function StorefrontRewardsPage() {
  const params = useParams<{ slug: string }>();
  const brandId = useSearchParams().get("brand");
  const slug = String(params.slug);
  const { customer, token, isLoading: authLoading } = useCustomerAuth();

  // The card is per LOCATION, and the slug may be one. The storefront payload
  // is already cached by the other tabs, so this costs nothing.
  const { data: store } = useQuery({
    queryKey: ["storefront", slug, brandId],
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/ordering/store/${slug}`, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data),
  });
  const locationId = (store as any)?.location?.id as string | undefined;
  const currency = (store as any)?.location?.currency ?? "GBP";

  const { data: card } = useQuery<CardState>({
    queryKey: ["loyalty-card", locationId, customer?.id],
    enabled: !!locationId && !!token,
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/loyalty/card`, {
          params: { locationId },
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.data),
  });

  const required = card?.stampsRequired ?? 6;
  const filled = card?.stamps ?? 0;
  const rewards = card?.rewards ?? [];

  // Which stamp is new since this device last looked. Only that one animates
  // — replaying the whole row on every visit would make the card feel like a
  // loading screen rather than a record of what someone has done.
  const [newestIndex, setNewestIndex] = useState<number | null>(null);
  const seenKey = `orderhub.loyalty.${locationId}`;
  const settled = useRef(false);
  useEffect(() => {
    if (!locationId || card?.active !== true || settled.current) return;
    settled.current = true;
    try {
      const seen = Number(window.localStorage.getItem(seenKey) ?? "0");
      const lifetime = card?.lifetimeStamps ?? 0;
      if (lifetime > seen && filled > 0) setNewestIndex(filled - 1);
      window.localStorage.setItem(seenKey, String(lifetime));
    } catch {
      /* private mode — the card still renders, it just never animates */
    }
  }, [locationId, card?.active, card?.lifetimeStamps, filled, seenKey]);

  const complete = rewards.length > 0;

  return (
    <main className="min-h-screen bg-zinc-950">
      <style jsx global>{`
        @keyframes oh-stamp-in {
          0% {
            opacity: 0;
            transform: scale(2.4) rotate(-18deg);
          }
          60% {
            opacity: 1;
            transform: scale(0.88) rotate(4deg);
          }
          100% {
            opacity: 1;
            transform: scale(1) rotate(0deg);
          }
        }
        @keyframes oh-card-in {
          from {
            opacity: 0;
            transform: translateY(18px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        @keyframes oh-shine {
          from {
            transform: translateX(-120%) skewX(-18deg);
          }
          to {
            transform: translateX(220%) skewX(-18deg);
          }
        }
        .oh-stamp-in {
          animation: oh-stamp-in 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        .oh-card-in {
          animation: oh-card-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .oh-shine::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.28),
            transparent
          );
          animation: oh-shine 2.4s ease-in-out 0.5s both;
        }
        @media (prefers-reduced-motion: reduce) {
          .oh-stamp-in,
          .oh-card-in,
          .oh-shine::after {
            animation: none !important;
          }
        }
      `}</style>

      <header className="px-5 pb-2 pt-8">
        <h1 className="text-2xl font-black tracking-tight text-white">
          {customer?.firstName ? `Hi ${customer.firstName}` : "Your loyalty card"}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          {(store as any)?.brand?.name ?? (store as any)?.location?.name ?? ""}
        </p>
      </header>

      {/* ── Signed out ───────────────────────────────────────────────── */}
      {!authLoading && !token && (
        <Panel>
          <Lock className="mb-3 h-6 w-6 text-zinc-500" />
          <h2 className="text-base font-bold text-white">Sign in to collect</h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            Your stamps follow your account, so they are here whichever phone
            you order from.
          </p>
        </Panel>
      )}

      {/* ── Shop runs no card ────────────────────────────────────────── */}
      {!!token && card?.active === false && (
        <Panel>
          <Heart className="mb-3 h-6 w-6 text-zinc-500" />
          <h2 className="text-base font-bold text-white">No card here yet</h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            This shop isn&apos;t running a loyalty card at the moment.
          </p>
        </Panel>
      )}

      {/* ── The card ─────────────────────────────────────────────────── */}
      {card?.active && (
        <section className="px-5 pb-2">
          <div
            className={`oh-card-in relative overflow-hidden rounded-3xl p-5 shadow-2xl ${
              complete
                ? "oh-shine bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500"
                : "bg-gradient-to-br from-zinc-800 to-zinc-900 ring-1 ring-white/10"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p
                  className={`text-[11px] font-bold uppercase tracking-widest ${
                    complete ? "text-white/80" : "text-zinc-400"
                  }`}
                >
                  {complete ? "Ready to claim" : "Your card"}
                </p>
                <p className="mt-1 text-xl font-black leading-tight text-white">
                  {card.rewardItem?.name ?? card.rewardLabel}
                </p>
              </div>
              {card.rewardItem?.imageUrl && (
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl ring-2 ring-white/20">
                  <Image
                    src={card.rewardItem.imageUrl}
                    alt=""
                    fill
                    sizes="56px"
                    className="object-cover"
                  />
                </div>
              )}
            </div>

            {/* The stamps. A grid, not a progress bar — a card you can count
                is the thing people already understand from paper. */}
            <div className="mt-5 grid grid-cols-6 gap-2.5">
              {Array.from({ length: required }).map((_, i) => {
                const on = i < filled;
                return (
                  <div
                    key={i}
                    className={`flex aspect-square items-center justify-center rounded-full text-sm font-black ${
                      on
                        ? complete
                          ? "bg-white text-orange-600"
                          : "bg-white text-zinc-900"
                        : "border-2 border-dashed border-white/25 text-white/30"
                    } ${i === newestIndex ? "oh-stamp-in" : ""}`}
                  >
                    {on ? <Heart className="h-4 w-4 fill-current" /> : i + 1}
                  </div>
                );
              })}
            </div>

            <p
              className={`mt-4 text-sm font-semibold ${
                complete ? "text-white" : "text-zinc-300"
              }`}
            >
              {complete
                ? "Claim it at checkout on your next order."
                : `${required - filled} more ${
                    required - filled === 1 ? "order" : "orders"
                  } to go.`}
            </p>
            {card.minimumSpend ? (
              <p
                className={`mt-1 text-xs ${complete ? "text-white/75" : "text-zinc-500"}`}
              >
                Spend {formatMoney(card.minimumSpend, currency)} or more to earn
                a stamp.
              </p>
            ) : null}
          </div>
        </section>
      )}

      {/* ── Rewards waiting ──────────────────────────────────────────── */}
      {rewards.length > 0 && (
        <section className="px-5 pt-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-white">
            <Sparkles className="h-4 w-4 text-amber-400" />
            {rewards.length === 1 ? "1 reward waiting" : `${rewards.length} rewards waiting`}
          </h2>
          <ul className="mt-2 space-y-2">
            {rewards.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-2xl bg-white/5 p-3 ring-1 ring-white/10"
              >
                <Ticket className="h-5 w-5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-white">{r.label}</p>
                  <p className="text-xs text-zinc-400">
                    {r.expiresAt
                      ? `Use by ${new Date(r.expiresAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                        })}`
                      : "No expiry"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <StorefrontTabBar
        slug={slug}
        brandId={brandId}
        rewardCount={rewards.length}
      />
    </main>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-5 mt-4 rounded-3xl bg-white/5 p-6 ring-1 ring-white/10">
      {children}
    </section>
  );
}
