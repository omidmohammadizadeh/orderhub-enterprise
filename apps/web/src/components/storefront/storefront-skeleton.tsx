// What the customer sees while the menu loads: the page's own shape, greyed
// out. A centred spinner on a blank screen reads as "broken" after a second;
// the outline of a menu reads as "nearly there", and nothing jumps when the
// real one lands in the same places.

import { MenuItemCardSkeleton } from "./menu-item-card";

export const StorefrontSkeleton = () => (
  <div className="sf-root min-h-screen" role="status">
    <div className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-sf-border bg-sf-surface px-4">
      <div className="sf-skeleton h-10 w-10 rounded-xl" />
      <div className="sf-skeleton h-4 w-32 rounded" />
      <div className="sf-skeleton ml-auto h-9 w-9 rounded-full" />
    </div>
    <div className="sf-skeleton h-44 w-full sm:h-64" />
    <div className="mx-auto max-w-6xl px-4">
      <div className="mt-5 space-y-2.5">
        <div className="sf-skeleton h-7 w-56 rounded" />
        <div className="sf-skeleton h-4 w-72 max-w-full rounded" />
        <div className="flex gap-2 pt-2">
          <div className="sf-skeleton h-11 w-28 rounded-full" />
          <div className="sf-skeleton h-11 w-28 rounded-full" />
        </div>
      </div>
      <div className="mt-6 flex gap-4 border-b border-sf-border pb-3">
        {[64, 88, 72, 96, 60].map((w) => (
          <div key={w} className="sf-skeleton h-4 shrink-0 rounded" style={{ width: w }} />
        ))}
      </div>
      <div className="sf-skeleton mt-6 h-6 w-36 rounded" />
      <div className="mt-3 grid gap-3 md:grid-cols-2 lg:max-w-[calc(100%-22rem)]">
        {Array.from({ length: 6 }, (_, i) => (
          <MenuItemCardSkeleton key={i} />
        ))}
      </div>
    </div>
    <span className="sr-only">Loading menu…</span>
  </div>
);
