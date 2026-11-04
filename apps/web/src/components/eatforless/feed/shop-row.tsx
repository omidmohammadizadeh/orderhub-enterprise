"use client";

import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { EflPublicShop } from "@/lib/api/efl.client";
import { FOCUS } from "../efl-styles";
import { ShopCard, ShopCardSkeleton, type FeedMode } from "./shop-card";

export type SavedProps = { saved: Set<string>; onToggleSaved: (id: string) => void };

const ROUND_BTN = `efl-press flex h-11 w-11 items-center justify-center rounded-full bg-[#F3F3F3] hover:bg-[#E2E2E2] ${FOCUS}`;

/** One titled, sideways-scrolling row of shops, with "See all" and arrows. */
export function ShopRow({
  id,
  title,
  shops,
  mode,
  onSeeAll,
  saved,
  onToggleSaved,
}: {
  id: string;
  title: string;
  shops: EflPublicShop[];
  mode: FeedMode;
  onSeeAll: () => void;
} & SavedProps) {
  const scroller = useRef<HTMLUListElement>(null);
  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="m-0 text-[22px] font-extrabold tracking-[-0.02em] sm:text-2xl">
          {title}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSeeAll}
            className={`efl-press min-h-[44px] rounded-full px-3 text-[15px] font-bold hover:bg-[#F3F3F3] ${FOCUS}`}
          >
            See all<span className="sr-only"> {title}</span>
          </button>
          <button type="button" onClick={() => scrollBy(-1)} aria-label={`Scroll ${title} back`} className={`${ROUND_BTN} hidden md:flex`}>
            <ArrowLeft aria-hidden="true" className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => scrollBy(1)} aria-label={`Scroll ${title} forward`} className={`${ROUND_BTN} hidden md:flex`}>
            <ArrowRight aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      </div>
      <ul
        ref={scroller}
        className="efl-scroll -mx-4 m-0 flex list-none snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-4 px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:scroll-px-0 lg:px-0"
      >
        {shops.map((shop, i) => (
          <li key={shop.id} className="w-[78vw] max-w-[320px] shrink-0 snap-start sm:w-[300px]">
            <ShopCard shop={shop} mode={mode} index={i} saved={saved.has(shop.id)} onToggleSaved={onToggleSaved} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ShopGrid({ shops, mode, saved, onToggleSaved }: { shops: EflPublicShop[]; mode: FeedMode } & SavedProps) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-7 p-0 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {shops.map((shop, i) => (
        <li key={shop.id}>
          <ShopCard shop={shop} mode={mode} index={i} saved={saved.has(shop.id)} onToggleSaved={onToggleSaved} />
        </li>
      ))}
    </ul>
  );
}

export function FeedSkeleton() {
  return (
    <div role="status" aria-label="Finding shops near you" className="flex flex-col gap-10">
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-col gap-3">
          <div className="efl-skel h-7 w-52 rounded-lg" />
          <div className="efl-scroll -mx-4 flex gap-4 overflow-hidden px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="w-[78vw] max-w-[320px] shrink-0 sm:w-[300px]">
                <ShopCardSkeleton />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
