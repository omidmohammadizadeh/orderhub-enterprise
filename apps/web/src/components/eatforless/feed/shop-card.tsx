"use client";

import Link from "next/link";
import { Heart, Star } from "lucide-react";
import type { EflPublicShop } from "@/lib/api/efl.client";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { FoodTile, foodKindFor } from "../food-art";

export type FeedMode = "DELIVERY" | "PICKUP";

export function money(n: number): string {
  return `£${n.toFixed(2)}`;
}

/** "(120+)" the way the big apps round review counts. */
export function reviewCount(count: number): string {
  if (count >= 1000) return `(${Math.floor(count / 1000)}k+)`;
  if (count >= 20) return `(${Math.floor(count / 10) * 10}+)`;
  return `(${count})`;
}

export function etaLabel(shop: EflPublicShop, mode: FeedMode): string | null {
  if (mode === "PICKUP") {
    const m = shop.collection.readyInMinutes;
    return m != null ? `Ready in ${m} min` : null;
  }
  const eta = shop.delivery.etaMinutes;
  if (!eta) return null;
  return eta.min === eta.max ? `${eta.min} min` : `${eta.min}–${eta.max} min`;
}

export function feeLabel(shop: EflPublicShop, mode: FeedMode): string {
  if (mode === "PICKUP") return `Collect · ${shop.distanceMiles.toFixed(1)} mi`;
  const fee = shop.delivery.fee;
  if (fee == null) return "Delivery";
  if (fee === 0) return "£0 Delivery Fee";
  return `${money(fee)} Delivery Fee`;
}

/** The black-and-lime tag on the photo: only ever a true fact about the shop. */
function tagFor(shop: EflPublicShop, mode: FeedMode): string | null {
  if (!shop.isOpen) return null;
  if (mode === "DELIVERY" && shop.delivery.fee === 0) return "Free delivery";
  if (mode === "DELIVERY" && !shop.collection.available) return null;
  if (mode === "PICKUP" && shop.collection.readyInMinutes != null && shop.collection.readyInMinutes <= 15) return "Quick collection";
  return null;
}

export function ShopImage({ shop, className = "" }: { shop: Pick<EflPublicShop, "heroImageUrl" | "cuisines" | "name">; className?: string }) {
  if (shop.heroImageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- shop images live on any host
      <img src={shop.heroImageUrl} alt="" loading="lazy" decoding="async" className={`h-full w-full object-cover ${className}`} />
    );
  }
  return <FoodTile kind={foodKindFor(shop.cuisines[0], shop.cuisines.join(" "), shop.name)} className={className} />;
}

export function ShopCard({
  shop,
  mode,
  saved,
  onToggleSaved,
  index = 0,
}: {
  shop: EflPublicShop;
  mode: FeedMode;
  saved: boolean;
  onToggleSaved: (id: string) => void;
  index?: number;
}) {
  const href = useEflHref();
  const tag = tagFor(shop, mode);
  const eta = etaLabel(shop, mode);
  const closed = !shop.isOpen;

  return (
    <article className="efl-fu relative flex flex-col gap-2.5" style={{ animationDelay: `${Math.min(index, 8) * 50}ms` }}>
      <Link
        href={href(`/shop/${encodeURIComponent(shop.id)}`)}
        className={`efl-press efl-lift group flex flex-col gap-2.5 rounded-2xl ${FOCUS}`}
      >
        <span className="relative block aspect-[16/9] overflow-hidden rounded-2xl bg-[#F3F3F3]">
          <span className={`efl-zoom block h-full ${closed ? "opacity-60 grayscale" : ""}`}>
            <ShopImage shop={shop} />
          </span>
          {tag ? (
            <span className="absolute left-2.5 top-2.5 rounded-md bg-[#0B0B0B] px-2 py-1 text-xs font-bold text-[#D4FF3F]">{tag}</span>
          ) : null}
          {closed ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-[#0B0B0B]/85 px-4 py-1.5 text-sm font-bold text-white">Closed</span>
            </span>
          ) : null}
        </span>
        <span className="flex flex-col gap-0.5 pr-11">
          <span className={`truncate text-base font-bold leading-snug ${closed ? "text-[#5E5E5E]" : ""}`}>{shop.name}</span>
          <span className="truncate text-sm text-[#5E5E5E]">{closed ? "Closed now" : feeLabel(shop, mode)}</span>
          <span className="flex items-center gap-1 text-sm text-[#5E5E5E]">
            {shop.rating ? (
              <>
                <span className="font-semibold text-[#0B0B0B]">{shop.rating.value.toFixed(1)}</span>
                <Star aria-hidden="true" className="h-3.5 w-3.5 fill-[#0B0B0B] text-[#0B0B0B]" />
                <span className="sr-only">stars from</span>
                <span>{reviewCount(shop.rating.count)}</span>
              </>
            ) : (
              <span className="rounded bg-[#D4FF3F] px-1.5 text-xs font-bold text-[#0B0B0B]">New</span>
            )}
            {eta ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{eta}</span>
              </>
            ) : null}
          </span>
        </span>
      </Link>
      {/* Sits just under the photo, beside the name — outside the link so
          the two never nest. The spacer is the photo's own 16:9 box. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col">
        <span aria-hidden="true" className="block aspect-[16/9]" />
        <div className="flex justify-end pt-0.5">
          <button
            type="button"
            onClick={() => onToggleSaved(shop.id)}
            aria-pressed={saved}
            aria-label={saved ? `Remove ${shop.name} from saved` : `Save ${shop.name}`}
            className={`efl-press pointer-events-auto -mr-2 flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`}
          >
            <Heart aria-hidden="true" className={`h-5 w-5 ${saved ? "fill-[#0B0B0B]" : ""}`} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function ShopCardSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      <div className="efl-skel aspect-[16/9] rounded-2xl" />
      <div className="efl-skel h-4 w-3/4 rounded" />
      <div className="efl-skel h-3.5 w-1/2 rounded" />
      <div className="efl-skel h-3.5 w-2/5 rounded" />
    </div>
  );
}
