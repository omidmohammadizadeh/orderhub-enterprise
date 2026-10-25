"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Clock, Home, Star, Store } from "lucide-react";
import { eflPublicClient, type EflPublicShop } from "@/lib/api/efl.client";
import { EFL_LAUNCH_TOWNS } from "@/lib/efl-site";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { CUISINES, FoodIcon, FoodTile } from "../food-art";
import { PostcodeSearch } from "../landing/postcode-search";
import { geocodePostcode, normalisePostcode, reverseGeocode } from "../postcode";
import { FeedTopBar } from "./feed-top-bar";
import type { FeedMode } from "./shop-card";
import { FeedSkeleton, ShopGrid, ShopRow } from "./shop-row";

type Place = { lat: number; lng: number; postcode?: string; label: string };
type PlaceState =
  | { status: "none" }
  | { status: "loading"; label: string }
  | { status: "error"; reason: "invalid" | "not-found" | "network"; postcode: string }
  | { status: "ready"; place: Place };

type Sort = "distance" | "rating" | "fee";
type SectionId = "popular" | "top-rated" | "quick";

const SAVED_KEY = "efl.savedShops";

/** Where the feed is for: a postcode (geocoded here) or the browser's own point. */
function usePlace(): PlaceState {
  const params = useSearchParams();
  const rawPostcode = params.get("postcode") ?? "";
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const hasPoint = params.has("lat") && params.has("lng") && Number.isFinite(lat) && Number.isFinite(lng);

  const geo = useQuery({
    queryKey: ["efl-geocode", rawPostcode.toUpperCase().replace(/\s+/g, "")],
    queryFn: ({ signal }) => geocodePostcode(rawPostcode, signal),
    enabled: !!rawPostcode && !hasPoint,
    staleTime: Infinity,
    retry: false,
  });
  const reverse = useQuery({
    queryKey: ["efl-reverse", lat, lng],
    queryFn: ({ signal }) => reverseGeocode(lat, lng, signal),
    enabled: hasPoint,
    staleTime: Infinity,
    retry: false,
  });

  if (hasPoint) {
    const pc = reverse.data ?? undefined;
    return { status: "ready", place: { lat, lng, postcode: pc, label: pc ?? "Current location" } };
  }
  if (!rawPostcode) return { status: "none" };
  if (geo.isPending) return { status: "loading", label: normalisePostcode(rawPostcode) ?? rawPostcode };
  const r = geo.data;
  if (!r) return { status: "error", reason: "network", postcode: rawPostcode };
  if (!r.ok) return { status: "error", reason: r.reason, postcode: rawPostcode };
  return { status: "ready", place: { lat: r.lat, lng: r.lng, postcode: r.postcode, label: r.postcode } };
}

/** Saved shops, kept on this device only (signing in arrives with the app). */
function useSavedShops(): [Set<string>, (id: string) => void] {
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SAVED_KEY);
      if (raw) setSaved(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* storage blocked — saving just won't persist */
    }
  }, []);
  const toggle = useCallback((id: string) => {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(SAVED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [saved, toggle];
}

function matchesCuisine(shop: EflPublicShop, cuisine: string): boolean {
  return shop.cuisines.some((c) => c.toLowerCase() === cuisine.toLowerCase());
}

function matchesSearch(shop: EflPublicShop, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [shop.name, shop.area ?? "", shop.description ?? "", ...shop.cuisines].some((t) => t.toLowerCase().includes(needle));
}

/** Open shops first, then the chosen order. */
function sortShops(shops: EflPublicShop[], sort: Sort): EflPublicShop[] {
  const key = (s: EflPublicShop): number => {
    if (sort === "rating") return -(s.rating?.value ?? 0);
    if (sort === "fee") return s.delivery.fee ?? Number.POSITIVE_INFINITY;
    return s.distanceMiles;
  };
  return [...shops].sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || key(a) - key(b) || a.distanceMiles - b.distanceMiles);
}

export function FeedPage() {
  const placeState = usePlace();
  const place = placeState.status === "ready" ? placeState.place : null;
  const [mode, setMode] = useState<FeedMode>("DELIVERY");
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [under30, setUnder30] = useState(false);
  const [sort, setSort] = useState<Sort>("distance");
  const [search, setSearch] = useState("");
  const [seeAll, setSeeAll] = useState<SectionId | null>(null);
  const [saved, toggleSaved] = useSavedShops();

  const shopsQuery = useQuery({
    queryKey: ["efl-shops", place?.lat, place?.lng, place?.postcode ?? null],
    queryFn: () => eflPublicClient.shops({ lat: place!.lat, lng: place!.lng, postcode: place!.postcode }),
    enabled: !!place,
    staleTime: 60_000,
  });

  const all = useMemo(() => shopsQuery.data ?? [], [shopsQuery.data]);
  const inMode = useMemo(
    () => all.filter((s) => (mode === "DELIVERY" ? s.delivery.available : s.collection.available)),
    [all, mode],
  );
  const filtered = useMemo(() => {
    let list = inMode;
    if (cuisine) list = list.filter((s) => matchesCuisine(s, cuisine));
    if (search.trim()) list = list.filter((s) => matchesSearch(s, search));
    if (under30) list = list.filter((s) => s.delivery.etaMinutes != null && s.delivery.etaMinutes.max <= 30);
    return sortShops(list, sort);
  }, [inMode, cuisine, search, under30, sort]);

  const sections = useMemo(() => {
    const out: Array<{ id: SectionId; title: string; shops: EflPublicShop[] }> = [
      { id: "popular", title: "Popular near you", shops: sortShops(inMode, "distance") },
      {
        id: "top-rated",
        title: "Top rated",
        shops: sortShops(inMode.filter((s) => (s.rating?.value ?? 0) >= 4.5), "rating"),
      },
      {
        id: "quick",
        title: "Quick delivery",
        shops: sortShops(
          inMode.filter((s) => s.delivery.etaMinutes != null && s.delivery.etaMinutes.max <= 30),
          "distance",
        ),
      },
    ];
    return out.filter((s) => s.shops.length > 0 && !(mode === "PICKUP" && s.id === "quick"));
  }, [inMode, mode]);

  const filtering = !!cuisine || !!search.trim() || under30 || sort !== "distance";
  const clearFilters = () => {
    setCuisine(null);
    setSearch("");
    setUnder30(false);
    setSort("distance");
    setSeeAll(null);
  };

  const locationLabel =
    placeState.status === "ready"
      ? placeState.place.label
      : placeState.status === "loading"
        ? placeState.label
        : placeState.status === "error"
          ? placeState.postcode.toUpperCase()
          : "Set your location";

  const seeAllSection = seeAll ? sections.find((s) => s.id === seeAll) : null;

  return (
    <>
      <FeedTopBar mode={mode} onModeChange={setMode} locationLabel={locationLabel} search={search} onSearch={setSearch} />
      <div className="mx-auto flex max-w-[1600px] gap-8 px-4 pb-20 pt-5 sm:px-6 lg:pt-6">
        <Sidebar showCuisines={all.length > 0} cuisine={cuisine} onCuisine={(c) => { setCuisine(c); setSeeAll(null); }} />
        <main id="main" className="flex min-w-0 flex-1 flex-col gap-6">
          <h1 className="sr-only">
            {place ? `Food near ${place.label}` : "Find food near you"}
          </h1>
          {/* Browsing tools only once there's something to browse. */}
          {all.length > 0 ? (
            <>
              <CuisineRow selected={cuisine} onSelect={(c) => { setCuisine(c); setSeeAll(null); }} />
              <FilterChips
                under30={under30}
                onUnder30={setUnder30}
                sort={sort}
                onSort={setSort}
                mode={mode}
                filtering={filtering}
                onClear={clearFilters}
              />
            </>
          ) : null}

          {placeState.status === "none" ? (
            <NeedLocation />
          ) : placeState.status === "error" ? (
            <LocationError reason={placeState.reason} postcode={placeState.postcode} />
          ) : placeState.status === "loading" || shopsQuery.isPending ? (
            <FeedSkeleton />
          ) : shopsQuery.isError ? (
            <LoadError onRetry={() => shopsQuery.refetch()} />
          ) : all.length === 0 ? (
            <NotInAreaYet label={place?.label ?? ""} />
          ) : seeAllSection ? (
            <section aria-labelledby="see-all-title" className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setSeeAll(null)} aria-label="Back to all sections" className={`efl-press flex h-11 w-11 items-center justify-center rounded-full bg-[#F3F3F3] hover:bg-[#E2E2E2] ${FOCUS}`}>
                  <ArrowLeft aria-hidden="true" className="h-5 w-5" />
                </button>
                <h2 id="see-all-title" className="m-0 text-2xl font-extrabold tracking-[-0.02em]">
                  {seeAllSection.title}
                </h2>
              </div>
              <ShopGrid shops={seeAllSection.shops} mode={mode} saved={saved} onToggleSaved={toggleSaved} />
            </section>
          ) : filtering ? (
            filtered.length > 0 ? (
              <section aria-labelledby="results-title" className="flex flex-col gap-4">
                <h2 id="results-title" className="m-0 text-2xl font-extrabold tracking-[-0.02em]">
                  {filtered.length} {filtered.length === 1 ? "shop" : "shops"}
                  {cuisine ? ` for ${cuisine}` : ""}
                </h2>
                <ShopGrid shops={filtered} mode={mode} saved={saved} onToggleSaved={toggleSaved} />
              </section>
            ) : (
              <NoMatches onClear={clearFilters} />
            )
          ) : inMode.length === 0 ? (
            <NoneInMode mode={mode} onSwitch={() => setMode(mode === "DELIVERY" ? "PICKUP" : "DELIVERY")} />
          ) : (
            <div className="flex flex-col gap-10">
              {sections.map((s) => (
                <ShopRow
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  shops={s.shops}
                  mode={mode}
                  onSeeAll={() => setSeeAll(s.id)}
                  saved={saved}
                  onToggleSaved={toggleSaved}
                />
              ))}
            </div>
          )}
          <p className="sr-only" aria-live="polite">
            {shopsQuery.isSuccess && place ? `${filtering ? filtered.length : inMode.length} shops found` : ""}
          </p>
        </main>
      </div>
    </>
  );
}

function Sidebar({
  showCuisines,
  cuisine,
  onCuisine,
}: {
  showCuisines: boolean;
  cuisine: string | null;
  onCuisine: (c: string | null) => void;
}) {
  const href = useEflHref();
  const item = (active: boolean) =>
    `efl-press flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-semibold ${FOCUS} ${
      active ? "bg-[#F3F3F3] font-bold" : "hover:bg-[#F3F3F3]"
    }`;
  return (
    <nav aria-label="Browse" className="sticky top-[88px] hidden h-fit w-[210px] shrink-0 flex-col gap-1 lg:flex">
      <button type="button" onClick={() => onCuisine(null)} aria-pressed={cuisine === null} className={item(cuisine === null)}>
        <Home aria-hidden="true" className="h-5 w-5" />
        Home
      </button>
      {showCuisines ? (
        <>
      <p className="m-0 mt-4 px-3 pb-1 text-xs font-bold uppercase tracking-[0.08em] text-[#5E5E5E]">Cuisines</p>
      {CUISINES.map((c) => (
        <button key={c.name} type="button" onClick={() => onCuisine(c.name)} aria-pressed={cuisine === c.name} className={item(cuisine === c.name)}>
          <span className="flex h-6 w-6 items-center justify-center">
            <FoodIcon kind={c.kind} size={24} />
          </span>
          {c.name}
        </button>
      ))}
        </>
      ) : null}
      <div className="my-3 h-px bg-[#E2E2E2]" />
      <Link href="/partner" className={item(false)}>
        <Store aria-hidden="true" className="h-5 w-5" />
        Partner with us
      </Link>
      <Link href={href("/help")} className={item(false)}>
        <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-current text-[11px] font-extrabold">
          ?
        </span>
        Help
      </Link>
    </nav>
  );
}

function CuisineRow({ selected, onSelect }: { selected: string | null; onSelect: (c: string | null) => void }) {
  return (
    <div role="group" aria-label="Cuisines" className="efl-scroll -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
      {CUISINES.map((c, i) => {
        const active = selected === c.name;
        return (
          <button
            key={c.name}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(active ? null : c.name)}
            className={`efl-press efl-fu group flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-2xl py-1.5 ${FOCUS}`}
            style={{ animationDelay: `${i * 30}ms` }}
          >
            <span
              className={`flex h-[60px] w-[60px] items-center justify-center rounded-full transition-colors ${
                active ? "bg-[#D4FF3F] ring-2 ring-[#0B0B0B]" : "bg-[#F3F3F3] group-hover:bg-[#E2E2E2]"
              }`}
            >
              <FoodIcon kind={c.kind} size={40} />
            </span>
            <span className={`text-[13px] leading-tight ${active ? "font-extrabold" : "font-semibold"}`}>{c.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={`efl-press inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold ${FOCUS} ${
        active ? "bg-[#0B0B0B] text-white" : "bg-[#F3F3F3] text-[#0B0B0B] hover:bg-[#E2E2E2]"
      }`}
    >
      {children}
    </button>
  );
}

function FilterChips({
  under30,
  onUnder30,
  sort,
  onSort,
  mode,
  filtering,
  onClear,
}: {
  under30: boolean;
  onUnder30: (v: boolean) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
  mode: FeedMode;
  filtering: boolean;
  onClear: () => void;
}) {
  return (
    <div role="group" aria-label="Filters" className="efl-scroll -mx-4 flex items-center gap-2 overflow-x-auto px-4 py-0.5 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
      {mode === "DELIVERY" ? (
        <Chip active={sort === "fee"} onClick={() => onSort(sort === "fee" ? "distance" : "fee")}>
          {sort === "fee" ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
          Delivery fee
        </Chip>
      ) : null}
      {mode === "DELIVERY" ? (
        <Chip active={under30} onClick={() => onUnder30(!under30)}>
          <Clock aria-hidden="true" className="h-4 w-4" />
          Under 30 min
        </Chip>
      ) : null}
      <Chip active={sort === "rating"} onClick={() => onSort(sort === "rating" ? "distance" : "rating")}>
        <Star aria-hidden="true" className="h-4 w-4" />
        Highest rated
      </Chip>
      {filtering ? (
        <button
          type="button"
          onClick={onClear}
          className={`efl-press min-h-[40px] shrink-0 rounded-full px-3 text-sm font-bold underline underline-offset-4 ${FOCUS}`}
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}

function StateCard({ children }: { children: React.ReactNode }) {
  return <section className="efl-fu flex flex-col items-center gap-5 rounded-[24px] bg-[#F3F3F3] px-5 py-12 text-center sm:px-10 sm:py-16">{children}</section>;
}

function NotInAreaYet({ label }: { label: string }) {
  return (
    <section aria-labelledby="empty-title" className="efl-fu flex flex-col overflow-hidden rounded-[28px] bg-[#0B0B0B] text-white lg:flex-row">
      <div className="flex flex-1 flex-col gap-5 p-7 sm:p-12">
        <span className="w-fit rounded-full bg-[#D4FF3F] px-3 py-1 text-[13px] font-bold text-[#0B0B0B]">{label || "Your area"}</span>
        <h2 id="empty-title" className="m-0 text-[34px] font-extrabold leading-[1] tracking-[-0.03em] sm:text-[48px]">
          We&rsquo;re not in your area yet
        </h2>
        <p className="m-0 max-w-[460px] text-[17px] leading-relaxed text-[#C9C9C9]">
          Eat For Less is launching in Newcastle and Tyne and Wear first, with more towns to follow. Check back soon.
        </p>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Launching first in">
          {EFL_LAUNCH_TOWNS.map((t) => (
            <li key={t} className="rounded-full border border-[#333] px-3 py-1.5 text-sm text-[#E2E2E2]">
              {t}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col gap-3 rounded-2xl bg-[#1A1A1A] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="m-0 text-lg font-extrabold">Own a takeaway?</p>
            <p className="m-0 text-sm text-[#BDBDBD]">Be one of the first shops on Eat For Less.</p>
          </div>
          <Link
            href="/partner"
            className="efl-press inline-flex min-h-[48px] w-fit items-center rounded-full bg-[#D4FF3F] px-6 text-[15px] font-bold text-[#0B0B0B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF3F]"
          >
            Partner with us
          </Link>
        </div>
      </div>
      <div aria-hidden="true" className="relative hidden min-h-[320px] lg:block lg:w-[38%]">
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-3 gap-2 p-2">
          {(["pizza", "burger", "curry", "kebab", "chinese", "dessert"] as const).map((k) => (
            <div key={k} className="overflow-hidden rounded-2xl">
              <FoodTile kind={k} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function NeedLocation() {
  return (
    <StateCard>
      <h2 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">Where should we look?</h2>
      <p className="m-0 max-w-[420px] text-base text-[#5E5E5E]">Enter your postcode to see the takeaways near you.</p>
      <PostcodeSearch />
    </StateCard>
  );
}

function LocationError({ reason, postcode }: { reason: "invalid" | "not-found" | "network"; postcode: string }) {
  const title =
    reason === "network" ? "We couldn't look up that postcode" : reason === "invalid" ? "That doesn't look like a postcode" : "That postcode wasn't found";
  const body =
    reason === "network" ? "Check your connection and try again." : "Check it and try again, or use your current location.";
  return (
    <StateCard>
      <h2 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">{title}</h2>
      <p className="m-0 max-w-[420px] text-base text-[#5E5E5E]">{body}</p>
      <PostcodeSearch initialPostcode={postcode} />
    </StateCard>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <StateCard>
      <h2 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">We couldn&rsquo;t load shops right now</h2>
      <p className="m-0 max-w-[420px] text-base text-[#5E5E5E]">Something went wrong on our side. Give it another go.</p>
      <button type="button" onClick={onRetry} className={`efl-press min-h-[48px] rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white ${FOCUS}`}>
        Try again
      </button>
    </StateCard>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <StateCard>
      <h2 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">No shops match</h2>
      <p className="m-0 max-w-[420px] text-base text-[#5E5E5E]">Try fewer filters or a different cuisine.</p>
      <button type="button" onClick={onClear} className={`efl-press min-h-[48px] rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white ${FOCUS}`}>
        Clear filters
      </button>
    </StateCard>
  );
}

function NoneInMode({ mode, onSwitch }: { mode: FeedMode; onSwitch: () => void }) {
  return (
    <StateCard>
      <h2 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">
        {mode === "DELIVERY" ? "No shops deliver here yet" : "No shops offer pick up here yet"}
      </h2>
      <p className="m-0 max-w-[420px] text-base text-[#5E5E5E]">
        {mode === "DELIVERY" ? "Some shops near you take collection orders." : "Some shops near you deliver."}
      </p>
      <button type="button" onClick={onSwitch} className={`efl-press min-h-[48px] rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white ${FOCUS}`}>
        {mode === "DELIVERY" ? "Show pick up" : "Show delivery"}
      </button>
    </StateCard>
  );
}
