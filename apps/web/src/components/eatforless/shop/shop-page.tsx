"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bike, Clock, MapPin, ShoppingBag, Smartphone, Star } from "lucide-react";
import {
  eflPublicClient,
  type EflPublicMenuItem,
  type EflPublicShop,
  type EflPublicShopMenu,
} from "@/lib/api/efl.client";
import { displayPrice } from "@/lib/menu/display-price";
import { useEflHref } from "../efl-base-context";
import { EflWordmark } from "../efl-logo";
import { FOCUS } from "../efl-styles";
import { FoodTile, foodKindFor } from "../food-art";
import { etaLabel, feeLabel, money, reviewCount } from "../feed/shop-card";

type Section = { id: string; title: string; items: EflPublicMenuItem[] };

function sectionsOf(data: EflPublicShopMenu): Section[] {
  return (data.store.menu?.categories ?? [])
    .map((c) => ({
      id: `cat-${c.id}`,
      title: c.name,
      items: c.items
        .map((row) => (row.priceOverride != null ? { ...row.item, basePrice: row.priceOverride } : row.item))
        .filter((it) => it.visibleToCustomers !== false),
    }))
    .filter((s) => s.items.length > 0);
}

function priceLabel(item: EflPublicMenuItem): string {
  const { amount, from } = displayPrice({ basePrice: Number(item.basePrice) || 0, productSkus: item.productSkus ?? [] });
  return `${from ? "From " : ""}${money(amount)}`;
}

function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 404;
}

/** The feed's numbers for this shop (rating, ETA, fee), when the visitor came from the feed. */
function useFeedShop(listingId: string): EflPublicShop | null {
  const qc = useQueryClient();
  return useMemo(() => {
    for (const [, data] of qc.getQueriesData<EflPublicShop[]>({ queryKey: ["efl-shops"] })) {
      const hit = data?.find((s) => s.id === listingId);
      if (hit) return hit;
    }
    return null;
  }, [qc, listingId]);
}

/** Which category is on screen, for the sticky tabs. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (ids.length === 0) return;
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-140px 0px -55% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

export function ShopPage({ listingId }: { listingId: string }) {
  const href = useEflHref();
  const router = useRouter();
  const feedShop = useFeedShop(listingId);
  const query = useQuery({
    queryKey: ["efl-menu", listingId],
    queryFn: () => eflPublicClient.menu(listingId),
    staleTime: 60_000,
  });

  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push(href("/near"));
  };

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[#E2E2E2] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-2 px-3 sm:px-5">
          <button
            type="button"
            onClick={back}
            aria-label="Back"
            className={`efl-press flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`}
          >
            <ArrowLeft aria-hidden="true" className="h-6 w-6" />
          </button>
          <Link href={href("/")} className={`rounded-lg ${FOCUS}`}>
            <EflWordmark size={28} />
            <span className="sr-only">Eat For Less home</span>
          </Link>
          <span
            aria-hidden="true"
            className="ml-auto flex h-11 w-11 items-center justify-center rounded-full text-[#5E5E5E]"
            title="Ordering opens in the app soon"
          >
            <ShoppingBag className="h-[22px] w-[22px]" />
          </span>
        </div>
      </header>

      {query.isPending ? (
        <ShopSkeleton />
      ) : query.isError ? (
        isNotFound(query.error) ? (
          <NotOnEfl />
        ) : (
          <div className="mx-auto flex max-w-[640px] flex-col items-center gap-4 px-4 py-24 text-center">
            <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">We couldn&rsquo;t load this menu</h1>
            <p className="m-0 text-[#5E5E5E]">Check your connection and try again.</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className={`efl-press min-h-[48px] rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}
            >
              Try again
            </button>
          </div>
        )
      ) : (
        <ShopContent data={query.data} feedShop={feedShop} />
      )}
    </>
  );
}

function ShopContent({ data, feedShop }: { data: EflPublicShopMenu; feedShop: EflPublicShop | null }) {
  const { listing, store } = data;
  const name = store.brand?.name || store.location.name;
  const sections = useMemo(() => sectionsOf(data), [data]);
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  const active = useActiveSection(ids);
  const tabsRef = useRef<HTMLDivElement>(null);
  const hero = listing.heroImageUrl || store.menu?.heroImage || store.menu?.bannerImage || null;
  const logo = listing.logoUrl || store.brand?.logoUrl || null;
  const kind = foodKindFor(listing.cuisines[0], listing.cuisines.join(" "), name);
  const address = [store.location.addressLine1, store.location.city, store.location.postcode].filter(Boolean).join(", ");
  const description = listing.description || store.location.about || null;

  // Keep the active tab in view as the page scrolls.
  useEffect(() => {
    if (!active || !tabsRef.current) return;
    const tab = tabsRef.current.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [active]);

  const goTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top = el.getBoundingClientRect().top + window.scrollY - 128;
    window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  };

  const chips: Array<{ icon: React.ReactNode; text: string }> = [];
  if (feedShop?.rating) {
    chips.push({
      icon: <Star aria-hidden="true" className="h-4 w-4 fill-current" />,
      text: `${feedShop.rating.value.toFixed(1)} ${reviewCount(feedShop.rating.count)}`,
    });
  }
  if (feedShop) {
    const eta = etaLabel(feedShop, feedShop.delivery.available ? "DELIVERY" : "PICKUP");
    if (eta) chips.push({ icon: <Clock aria-hidden="true" className="h-4 w-4" />, text: eta });
    if (feedShop.delivery.available) chips.push({ icon: <Bike aria-hidden="true" className="h-4 w-4" />, text: feeLabel(feedShop, "DELIVERY") });
    chips.push({ icon: <MapPin aria-hidden="true" className="h-4 w-4" />, text: `${feedShop.distanceMiles.toFixed(1)} mi` });
  } else {
    if (listing.acceptsDelivery) chips.push({ icon: <Bike aria-hidden="true" className="h-4 w-4" />, text: "Delivery" });
    if (listing.acceptsCollection) {
      const prep = store.directConfig?.collectionPrepMinutes;
      chips.push({ icon: <Clock aria-hidden="true" className="h-4 w-4" />, text: prep ? `Collection in ~${prep} min` : "Collection" });
    }
  }

  return (
    <>
      <div className="mx-auto max-w-[1200px] px-0 sm:px-5 sm:pt-5">
        <div className="relative">
          <div className="efl-fu relative aspect-[16/9] overflow-hidden bg-[#F3F3F3] sm:aspect-[3/1] sm:rounded-[20px]">
            {hero ? (
              // eslint-disable-next-line @next/next/no-img-element -- shop images live on any host
              <img src={hero} alt="" className={`h-full w-full object-cover ${store.isOpen ? "" : "grayscale"}`} />
            ) : (
              <FoodTile kind={kind} />
            )}
          </div>
          <div className="absolute -bottom-9 left-4 flex h-[76px] w-[76px] items-center justify-center overflow-hidden rounded-full border-4 border-white bg-white shadow-md sm:left-6 sm:h-[88px] sm:w-[88px]">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- shop images live on any host
              <img src={logo} alt={`${name} logo`} className="h-full w-full object-cover" />
            ) : (
              <span aria-hidden="true" className="text-[30px] font-extrabold">
                {name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 pt-12 sm:px-5">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[32px] font-extrabold leading-[1.05] tracking-[-0.02em] sm:text-[44px]">{name}</h1>
          {listing.cuisines.length > 0 ? (
            <p className="m-0 text-[15px] font-semibold text-[#5E5E5E]">{listing.cuisines.join(" · ")}</p>
          ) : null}
          {description ? <p className="m-0 max-w-[680px] text-base leading-relaxed text-[#5E5E5E]">{description}</p> : null}
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="About this shop">
          <li
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3.5 text-sm font-bold ${
              store.isOpen ? "bg-[#D4FF3F] text-[#0B0B0B]" : "bg-[#0B0B0B] text-white"
            }`}
          >
            {store.isOpen ? "Open now" : "Closed"}
          </li>
          {chips.map((c) => (
            <li key={c.text} className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-[#F3F3F3] px-3.5 text-sm font-semibold">
              {c.icon}
              {c.text}
            </li>
          ))}
        </ul>
        {address ? (
          <p className="m-0 flex items-center gap-1.5 text-sm text-[#5E5E5E]">
            <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
            {address}
          </p>
        ) : null}
      </div>

      {sections.length > 0 ? (
        <nav
          aria-label="Menu categories"
          className="sticky top-16 z-30 mt-6 border-b border-[#E2E2E2] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85"
        >
          <div ref={tabsRef} className="efl-scroll mx-auto flex max-w-[1200px] gap-1 overflow-x-auto px-3 py-2 sm:px-5">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                data-tab={s.id}
                aria-current={active === s.id ? "true" : undefined}
                onClick={() => goTo(s.id)}
                className={`efl-press min-h-[44px] shrink-0 whitespace-nowrap rounded-full px-4 text-[15px] font-bold ${FOCUS} ${
                  active === s.id ? "bg-[#0B0B0B] text-white" : "hover:bg-[#F3F3F3]"
                }`}
              >
                {s.title}
              </button>
            ))}
          </div>
        </nav>
      ) : null}

      <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-4 pb-32 pt-6 sm:px-5">
        {sections.length === 0 ? (
          <p className="m-0 rounded-2xl bg-[#F3F3F3] p-8 text-center text-[#5E5E5E]">This shop&rsquo;s menu isn&rsquo;t available right now.</p>
        ) : (
          sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="flex scroll-mt-32 flex-col gap-4">
              <h2 id={`${s.id}-h`} className="m-0 text-2xl font-extrabold tracking-[-0.02em]">
                {s.title}
              </h2>
              <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
                {s.items.map((item) => (
                  <MenuItemCard key={item.id} item={item} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-5">
        <div
          role="note"
          className="pointer-events-auto mx-auto flex max-w-[720px] items-center gap-3 rounded-2xl bg-[#0B0B0B] px-4 py-3.5 text-white shadow-[0_12px_40px_rgba(0,0,0,.25)] sm:px-5"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#D4FF3F] text-[#0B0B0B]">
            <Smartphone aria-hidden="true" className="h-5 w-5" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[15px] font-extrabold">Order in the Eat For Less app</span>
            <span className="text-sm text-[#D4FF3F]">Coming soon</span>
          </span>
        </div>
      </div>
    </>
  );
}

function MenuItemCard({ item }: { item: EflPublicMenuItem }) {
  const soldOut = item.isAvailable === false || item.outOfStock === true;
  return (
    <li className={`flex min-h-[112px] gap-4 rounded-2xl border border-[#E2E2E2] p-4 ${soldOut ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="m-0 text-base font-bold leading-snug">{item.name}</h3>
        {item.description ? <p className="m-0 line-clamp-2 text-sm leading-snug text-[#5E5E5E]">{item.description}</p> : null}
        <p className="m-0 mt-auto pt-1 text-[15px] font-semibold">
          {priceLabel(item)}
          {soldOut ? <span className="ml-2 rounded bg-[#0B0B0B] px-1.5 py-0.5 text-xs font-bold text-white">Sold out</span> : null}
        </p>
        <p className="m-0 text-xs font-semibold text-[#5E5E5E]">Order in the app — coming soon</p>
      </div>
      {/* No photo, no box: a drawn tile on every line would just be noise. */}
      {item.imageUrl ? (
        <div className="h-[100px] w-[100px] shrink-0 overflow-hidden rounded-xl bg-[#F3F3F3] sm:h-[112px] sm:w-[112px]">
          {/* eslint-disable-next-line @next/next/no-img-element -- menu images live on any host */}
          <img src={item.imageUrl} alt={item.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      ) : null}
    </li>
  );
}

function NotOnEfl() {
  const href = useEflHref();
  return (
    <div className="mx-auto flex max-w-[640px] flex-col items-center gap-5 px-4 py-24 text-center">
      <div className="h-28 w-28 overflow-hidden rounded-full">
        <FoodTile kind="pizza" />
      </div>
      <h1 className="m-0 text-[30px] font-extrabold leading-tight tracking-[-0.02em]">This shop isn&rsquo;t on Eat For Less right now</h1>
      <p className="m-0 text-base text-[#5E5E5E]">It may have paused its listing. Have a look at what else is near you.</p>
      <Link
        href={href("/")}
        className={`efl-press inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white ${FOCUS}`}
      >
        Find food near you
      </Link>
    </div>
  );
}

function ShopSkeleton() {
  return (
    <div role="status" aria-label="Loading menu" className="mx-auto flex max-w-[1200px] flex-col gap-6 sm:px-5 sm:pt-5">
      <div className="efl-skel aspect-[16/9] sm:aspect-[3/1] sm:rounded-[20px]" />
      <div className="flex flex-col gap-3 px-4 pt-6 sm:px-0">
        <div className="efl-skel h-10 w-2/3 max-w-[420px] rounded-lg" />
        <div className="efl-skel h-4 w-1/3 rounded" />
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="efl-skel h-9 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <div className="grid gap-3 px-4 sm:px-0 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="efl-skel h-[132px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
