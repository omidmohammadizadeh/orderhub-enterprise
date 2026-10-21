"use client";

// The shop's own homepage — what a guest lands on from Instagram, Google or
// the window QR, before they book: who the shop is, what it costs, who
// cuts, what their work looks like, the loyalty card, and how to get there.
//
// One accent (brass), the barber pole used once (the hero's edge), and the
// shop's own photos doing the heavy lifting. Everything that says "book"
// drops the guest straight into the booking flow with that service or that
// person already chosen.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock, ExternalLink, Instagram, MapPin, Navigation, Phone, Star, UsersRound } from "lucide-react";
import { StampIcon, readableOn } from "@/components/loyalty/wallet-card";
import { minutesLabel, publicSalonClient, type PublicShop } from "@/lib/api/salon.client";
import { SP, display, money, staffNoun } from "./salon-public-ui";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_LABEL: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** "Open now · until 18:00" / "Closed · opens Tuesday 09:00" in the shop's own time. */
function openState(hours: PublicShop["hours"], tz: string, now = new Date()) {
  const has = DAYS.some((d) => (hours[d]?.length ?? 0) > 0);
  if (!has) return null;
  const wd = now.toLocaleDateString("en-GB", { timeZone: tz, weekday: "long" }).toLowerCase();
  const hm = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = hours[wd] ?? [];
  const open = today.find((s) => hm >= s.from && hm < s.to);
  if (open) return { open: true, text: `Open now · until ${open.to}`, today: wd };
  const later = today.find((s) => s.from > hm);
  if (later) return { open: false, text: `Closed · opens ${later.from} today`, today: wd };
  const start = DAYS.indexOf(wd as (typeof DAYS)[number]);
  for (let i = 1; i <= 7; i++) {
    const d = DAYS[(start + i) % 7]!;
    const first = hours[d]?.[0];
    if (first) return { open: false, text: `Closed · opens ${i === 1 ? "tomorrow" : DAY_LABEL[d]} ${first.from}`, today: wd };
  }
  return { open: false, text: "Closed", today: wd };
}

export function SalonHome({
  shop,
  onBook,
}: {
  shop: PublicShop;
  onBook: (pick?: { serviceId?: string; staffId?: string }) => void;
}) {
  const tz = shop.timezone;
  const state = useMemo(() => openState(shop.hours, tz), [shop.hours, tz]);
  const queue = useQuery({
    queryKey: ["salon-public", "board", shop.locationId],
    queryFn: () => publicSalonClient.queueBoard(shop.locationId),
    enabled: shop.queueOnlineJoin,
    refetchInterval: 60_000,
    retry: false,
  });
  const categories = useMemo(() => {
    const m = new Map<string, PublicShop["services"]>();
    for (const s of shop.services) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return Array.from(m.entries());
  }, [shop.services]);
  const [cat, setCat] = useState<string | null>(null);
  const shownCats = cat ? categories.filter(([c]) => c === cat) : categories;
  const noun = staffNoun(shop.trade);
  // The written address wins: it's what the shop typed, and searching for
  // "name, address" lands on Google's own listing for the shop. Saved
  // coordinates are only a fallback (they're set lazily, and can be stale).
  const mapQuery =
    shop.addressLines.length > 0
      ? [shop.name, ...shop.addressLines].join(", ")
      : `${shop.latitude},${shop.longitude}`;
  const hasAddress = shop.addressLines.length > 0 || (shop.latitude != null && shop.longitude != null);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery)}`;
  const tel = shop.phone?.replace(/[^\d+]/g, "") ?? "";
  const hasHours = DAYS.some((d) => (shop.hours[d]?.length ?? 0) > 0);
  const from = shop.services.length ? Math.min(...shop.services.map((s) => s.price)) : null;
  const queueWait =
    queue.data && queue.data.queueEnabled && queue.data.openNow !== false && queue.data.nextWaitMins != null
      ? queue.data.nextWaitMins
      : null;

  return (
    <main className="min-h-screen pb-28 font-[family-name:var(--font-salon)]" style={{ background: SP.paper, color: SP.ink }}>
      {/* ── Hero ── */}
      <header className="relative overflow-hidden text-white" style={{ background: SP.ink }}>
        {shop.coverImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shop.coverImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div
          className="absolute inset-0"
          style={{
            background: shop.coverImageUrl
              ? "linear-gradient(180deg, rgba(20,24,27,.35) 0%, rgba(20,24,27,.55) 45%, rgba(20,24,27,.94) 100%)"
              : `radial-gradient(120% 90% at 85% 0%, #2b343a 0%, ${SP.ink} 60%)`,
          }}
        />
        <div className="relative mx-auto flex min-h-[420px] max-w-5xl flex-col justify-end px-5 pb-10 pt-8 sm:min-h-[480px] sm:px-8">
          <div className="mb-auto flex items-center justify-between gap-3">
            {shop.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shop.logoUrl} alt="" className="h-14 w-14 rounded-2xl bg-white object-contain p-1.5 shadow-lg" />
            ) : (
              <span className={`grid h-14 w-14 place-items-center rounded-2xl bg-white/10 text-2xl ${display}`}>{shop.name.slice(0, 1)}</span>
            )}
            <div className="flex gap-2">
              {shop.instagram && (
                <a
                  href={`https://instagram.com/${shop.instagram}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${shop.name} on Instagram`}
                  className="grid h-11 w-11 place-items-center rounded-full bg-white/10 backdrop-blur hover:bg-white/20"
                >
                  <Instagram className="h-5 w-5" />
                </a>
              )}
              {tel && (
                <a href={`tel:${tel}`} aria-label={`Call ${shop.name}`} className="grid h-11 w-11 place-items-center rounded-full bg-white/10 backdrop-blur hover:bg-white/20">
                  <Phone className="h-5 w-5" />
                </a>
              )}
            </div>
          </div>
          {state && (
            <p className="mb-3 inline-flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-medium backdrop-blur">
              <span className={`h-2 w-2 rounded-full ${state.open ? "bg-emerald-400" : "bg-zinc-400"}`} aria-hidden />
              {state.text}
            </p>
          )}
          <h1 className={`text-[3rem] leading-[0.92] [text-wrap:balance] sm:text-[4.5rem] ${display}`}>{shop.name}</h1>
          {shop.about && <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-white/80 [text-wrap:pretty]">{shop.about}</p>}
          {shop.addressLines[0] && (
            <p className="mt-2 flex items-center gap-1.5 text-[14px] text-white/70">
              <MapPin className="h-4 w-4" aria-hidden /> {shop.addressLines.join(", ")}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => onBook()}
              className="inline-flex h-13 items-center gap-2 rounded-2xl px-6 py-3.5 text-[16px] font-semibold text-white shadow-lg transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              style={{ background: SP.brass }}
            >
              {shop.onlineBookingEnabled ? "Book an appointment" : shop.phone ? "Call to book" : "Walk-ins welcome"}{" "}
              <ArrowRight className="h-5 w-5" aria-hidden />
            </button>
            {shop.queueOnlineJoin && (
              <a
                href={`/salon/${shop.locationId}/queue`}
                className="inline-flex items-center gap-2 rounded-2xl bg-white/10 px-5 py-3.5 text-[15px] font-semibold backdrop-blur hover:bg-white/20"
              >
                <UsersRound className="h-5 w-5" aria-hidden />
                Walk in{queueWait != null ? (queueWait <= 5 ? " · no wait" : ` · ~${Math.round(queueWait / 5) * 5} min`) : ""}
              </a>
            )}
          </div>
        </div>
        <div
          className="relative h-1.5"
          style={{
            backgroundImage:
              shop.trade === "BARBER"
                ? `repeating-linear-gradient(-45deg, ${SP.red} 0 12px, #fff 12px 24px, ${SP.blue} 24px 36px, #fff 36px 48px)`
                : `repeating-linear-gradient(-45deg, ${SP.brass} 0 12px, #fff 12px 24px, ${SP.ink} 24px 36px, #fff 36px 48px)`,
          }}
          aria-hidden
        />
      </header>

      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        {/* ── Services ── */}
        <section className="pt-12" aria-labelledby="services-h">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="services-h" className={`text-[2rem] leading-none ${display}`}>
              Services
            </h2>
            {from != null && <p className="text-[14px]" style={{ color: SP.steel }}>From {money(from, shop.currency)}</p>}
          </div>
          {categories.length > 1 && (
            <div className="-mx-5 mt-4 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
              {[null, ...categories.map(([c]) => c)].map((c) => (
                <button
                  key={c ?? "all"}
                  type="button"
                  onClick={() => setCat(c)}
                  aria-pressed={cat === c}
                  className="h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium transition"
                  style={{ borderColor: cat === c ? SP.ink : SP.line, background: cat === c ? SP.ink : "white", color: cat === c ? "white" : SP.ink }}
                >
                  {c ?? "All"}
                </button>
              ))}
            </div>
          )}
          <div className="mt-5 grid gap-x-10 gap-y-8 md:grid-cols-2">
            {shownCats.map(([c, list]) => (
              <div key={c}>
                <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-[0.12em]" style={{ color: SP.brass }}>
                  {c}
                </h3>
                <ul>
                  {list.map((s) => (
                    <li key={s.id} className="border-b" style={{ borderColor: SP.line }}>
                      <button type="button" onClick={() => onBook({ serviceId: s.id })} className="group flex w-full items-start gap-4 py-4 text-left">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="text-[17px] font-semibold">{s.name}</span>
                            <span className="flex-1 translate-y-[-3px] border-b border-dotted" style={{ borderColor: SP.line }} aria-hidden />
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-[13px]" style={{ color: SP.steel }}>
                            <Clock className="h-3.5 w-3.5" aria-hidden /> {minutesLabel(s.durationMins)}
                            {s.addons.length > 0 && ` · ${s.addons.length} extra${s.addons.length === 1 ? "" : "s"}`}
                          </span>
                          {s.description && (
                            <span className="mt-1 block text-[14px] leading-snug [text-wrap:pretty]" style={{ color: SP.steel }}>
                              {s.description}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-[17px] font-semibold tabular-nums">
                            {s.priceFrom && <span className="mr-1 text-[12px] font-normal">from</span>}
                            {money(s.price, shop.currency)}
                          </span>
                          {shop.onlineBookingEnabled && (
                            <span
                              className="mt-1 inline-block rounded-full px-3 py-1 text-[12px] font-semibold opacity-80 transition group-hover:opacity-100"
                              style={{ background: SP.brassSoft, color: SP.brass }}
                            >
                              Book
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Team ── */}
        {shop.staff.length > 0 && (
          <section className="pt-14" aria-labelledby="team-h">
            <h2 id="team-h" className={`text-[2rem] leading-none ${display}`}>
              Meet the team
            </h2>
            <ul className="-mx-5 mt-5 flex snap-x gap-4 overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0">
              {shop.staff.map((p) => (
                <li key={p.id} className="w-[72%] shrink-0 snap-start sm:w-auto">
                  <div className="overflow-hidden rounded-3xl bg-white" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
                    <div className="relative aspect-[4/3]" style={{ background: SP.ink }}>
                      {p.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.avatarUrl} alt={p.name} className="h-full w-full object-cover" />
                      ) : (
                        <span className={`absolute inset-0 grid place-items-center text-[4rem] text-white/90 ${display}`}>
                          {p.name.slice(0, 1)}
                        </span>
                      )}
                    </div>
                    <div className="p-4">
                      <p className="text-[18px] font-semibold">{p.name}</p>
                      <p className="text-[13px]" style={{ color: SP.brass }}>
                        {p.title ?? noun[0]!.toUpperCase() + noun.slice(1)}
                      </p>
                      {p.bio && (
                        <p className="mt-2 line-clamp-3 text-[14px] leading-snug" style={{ color: SP.steel }}>
                          {p.bio}
                        </p>
                      )}
                      {shop.onlineBookingEnabled && (
                      <button
                        type="button"
                        onClick={() => onBook({ staffId: p.id })}
                        className="mt-3 inline-flex items-center gap-1 text-[14px] font-semibold underline-offset-4 hover:underline"
                      >
                        Book with {p.name.split(" ")[0]} <ArrowRight className="h-4 w-4" aria-hidden />
                      </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Gallery ── */}
        {shop.gallery.length > 0 && (
          <section className="pt-14" aria-labelledby="work-h">
            <div className="flex items-end justify-between">
              <h2 id="work-h" className={`text-[2rem] leading-none ${display}`}>
                Our work
              </h2>
              {shop.instagram && (
                <a href={`https://instagram.com/${shop.instagram}`} target="_blank" rel="noreferrer" className="text-[14px] font-semibold underline-offset-4 hover:underline">
                  @{shop.instagram}
                </a>
              )}
            </div>
            <ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              {shop.gallery.map((src, i) => (
                <li key={src} className={`overflow-hidden rounded-2xl ${i === 0 ? "col-span-2 row-span-2 sm:col-span-2" : ""}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" loading="lazy" className="aspect-square h-full w-full object-cover transition duration-500 hover:scale-[1.03]" />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Loyalty ── */}
        {shop.loyalty && <LoyaltyBlock shop={shop} />}

        {/* ── Visit ── */}
        {(hasAddress || hasHours || tel) && (
          <section className="pt-14" aria-labelledby="visit-h">
            <h2 id="visit-h" className={`text-[2rem] leading-none ${display}`}>
              Visit us
            </h2>
            <div className="mt-5 grid overflow-hidden rounded-3xl bg-white md:grid-cols-[1.25fr_1fr]" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
              {hasAddress && (
                <div className="relative min-h-[260px]" style={{ background: SP.line }}>
                  <iframe
                    title={`Map showing ${shop.name}`}
                    src={`https://maps.google.com/maps?q=${encodeURIComponent(mapQuery)}&z=16&output=embed`}
                    className="absolute inset-0 h-full w-full border-0"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                </div>
              )}
              <div className="space-y-5 p-6">
                {shop.addressLines.length > 0 && (
                  <div>
                    <p className="text-[13px] font-semibold uppercase tracking-[0.12em]" style={{ color: SP.brass }}>
                      Address
                    </p>
                    <address className="mt-1 text-[16px] not-italic leading-snug">
                      {shop.addressLines.map((l) => (
                        <span key={l} className="block">
                          {l}
                        </span>
                      ))}
                    </address>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={directions}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-10 items-center gap-1.5 rounded-xl px-4 text-[14px] font-semibold text-white"
                        style={{ background: SP.ink }}
                      >
                        <Navigation className="h-4 w-4" aria-hidden /> Directions
                      </a>
                      {tel && (
                        <a href={`tel:${tel}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl border px-4 text-[14px] font-semibold" style={{ borderColor: SP.line }}>
                          <Phone className="h-4 w-4" aria-hidden /> {shop.phone}
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {hasHours && (
                  <div>
                    <p className="text-[13px] font-semibold uppercase tracking-[0.12em]" style={{ color: SP.brass }}>
                      Opening hours
                    </p>
                    <dl className="mt-2 space-y-1 text-[15px]">
                      {DAYS.map((d) => {
                        const isToday = state?.today === d;
                        const slots = shop.hours[d] ?? [];
                        return (
                          <div key={d} className={`flex justify-between gap-4 rounded-lg px-2 py-1 ${isToday ? "font-semibold" : ""}`} style={isToday ? { background: SP.brassSoft } : undefined}>
                            <dt>{DAY_LABEL[d]}</dt>
                            <dd className="tabular-nums" style={{ color: slots.length ? SP.ink : SP.steel }}>
                              {slots.length ? slots.map((s) => `${s.from}–${s.to}`).join(", ") : "Closed"}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── Reviews ── */}
        {shop.googleReviewUrl && (
          <section className="pt-14">
            <div className="flex flex-col items-start gap-4 rounded-3xl p-6 sm:flex-row sm:items-center sm:justify-between" style={{ background: SP.ink, color: "white" }}>
              <div className="flex items-center gap-3">
                <span className="flex" aria-hidden>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Star key={i} className="h-5 w-5 fill-current" style={{ color: "#E7C277" }} />
                  ))}
                </span>
                <p className="text-[16px]">Been in? Tell people how it went.</p>
              </div>
              <a
                href={shop.googleReviewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-white px-4 text-[14px] font-semibold"
                style={{ color: SP.ink }}
              >
                Review us on Google <ExternalLink className="h-4 w-4" aria-hidden />
              </a>
            </div>
          </section>
        )}

        {(shop.bookingPolicy || shop.cancellationWindowHours > 0) && (
          <p className="pt-10 text-[13px] leading-relaxed" style={{ color: SP.steel }}>
            {shop.bookingPolicy && <>{shop.bookingPolicy} </>}
            {shop.cancellationWindowHours > 0 && `Free to change or cancel up to ${shop.cancellationWindowHours} hours before.`}
          </p>
        )}
        <p className="pt-6 text-center text-[12px]" style={{ color: SP.steel }}>
          Bookings by{" "}
          <a href="https://www.orderhubsolutions.com" className="underline underline-offset-2">
            OrderHub
          </a>
        </p>
      </div>

      {/* ── Sticky book bar (phones) ── */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white/95 px-4 py-3 backdrop-blur sm:hidden" style={{ borderColor: SP.line }}>
        <button
          type="button"
          onClick={() => onBook()}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[16px] font-semibold text-white"
          style={{ background: SP.ink }}
        >
          {shop.onlineBookingEnabled ? "Book an appointment" : shop.phone ? "Call to book" : "See you soon"}
          {state && <span className="text-[13px] font-normal opacity-70">· {state.open ? "open now" : "closed now"}</span>}
        </button>
      </div>
    </main>
  );
}

function LoyaltyBlock({ shop }: { shop: PublicShop }) {
  const l = shop.loyalty!;
  const bg = l.cardColor || SP.ink;
  const fg = readableOn(bg);
  return (
    <section className="pt-14" aria-labelledby="loyalty-h">
      <div className="grid items-center gap-8 rounded-3xl bg-white p-6 sm:p-8 md:grid-cols-2" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
        <div>
          <h2 id="loyalty-h" className={`text-[2rem] leading-none ${display}`}>
            Every visit counts
          </h2>
          <p className="mt-3 text-[16px] leading-relaxed" style={{ color: SP.steel }}>
            Collect a stamp each time you come in. After {l.stampsRequired}, you get <strong style={{ color: SP.ink }}>{l.rewardLabel}</strong>.
            The card lives in your phone&rsquo;s wallet — nothing to carry, nothing to lose.
          </p>
          <a
            href={l.joinUrl}
            className="mt-5 inline-flex h-12 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold text-white"
            style={{ background: SP.brass }}
          >
            Get the free card <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
        <div className="rounded-3xl p-5 shadow-xl" style={{ background: bg, color: fg }} aria-hidden>
          <div className="flex items-center justify-between">
            <p className={`text-[1.4rem] ${display}`}>{shop.name}</p>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-70">Rewards</p>
          </div>
          <div className="mt-5 grid grid-cols-6 gap-2">
            {Array.from({ length: Math.min(12, l.stampsRequired) }, (_, i) => (
              <span
                key={i}
                className="grid aspect-square place-items-center rounded-full border-2"
                style={{ borderColor: fg, opacity: i < 2 ? 1 : 0.35, background: i < 2 ? fg : "transparent", color: bg }}
              >
                {i < 2 && <StampIcon icon={l.stampIcon ?? "scissors"} className="h-1/2 w-1/2" />}
              </span>
            ))}
          </div>
          <p className="mt-4 text-[13px] opacity-75">{l.rewardLabel} on stamp {l.stampsRequired}</p>
        </div>
      </div>
    </section>
  );
}
