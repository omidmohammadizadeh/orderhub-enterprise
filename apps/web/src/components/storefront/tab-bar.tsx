"use client";

// The mobile tab bar for a brand's storefront.
//
// Modelled on the KFC and Nando's apps, and for the same reason they do it:
// on a phone, a storefront is not one long page. It is four places you move
// between — what's on, what you can order, what you have ordered, and what you
// have earned — and a footer is the only navigation that stays reachable with
// a thumb while scrolling a long menu.
//
// Mobile ONLY. On a laptop a fixed bar at the bottom of a wide window is just
// a strip of chrome eating vertical space, and the desktop storefront already
// has its header. `md:hidden` rather than a viewport hook so it is correct on
// first paint — a hook would flash the bar on desktop for a frame.
//
// Menu stays the DEFAULT route. Every QR code, printed link and Google result
// points at /order/<slug>, and someone who scans a code at a table wants the
// menu, not an advert. Home is a tab you choose, not one you land on.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, UtensilsCrossed, Receipt, Heart } from "lucide-react";

export interface TabBarProps {
  /** The storefront's own path segment — a slug or a location id. */
  slug: string;
  /** Kept on every tab: the brand overlay is load-bearing for pricing. */
  brandId?: string | null;
  /** Unclaimed rewards, shown as a dot on the loyalty tab. */
  rewardCount?: number;
}

export function StorefrontTabBar({ slug, brandId, rewardCount = 0 }: TabBarProps) {
  const pathname = usePathname();
  const base = `/order/${encodeURIComponent(slug)}`;
  const q = brandId ? `?brand=${encodeURIComponent(brandId)}` : "";

  const tabs = [
    { href: `${base}/home`, label: "Home", icon: Home },
    { href: base, label: "Menu", icon: UtensilsCrossed },
    { href: `${base}/my-orders`, label: "Orders", icon: Receipt },
    { href: `${base}/rewards`, label: "Rewards", icon: Heart, badge: rewardCount },
  ];

  return (
    <>
      {/* Reserves the space the fixed bar occupies, including the home
          indicator on a notched phone. Without it the last row of the menu
          sits underneath the bar and cannot be tapped. */}
      <div
        className="md:hidden"
        style={{ height: "calc(4.25rem + env(safe-area-inset-bottom))" }}
        aria-hidden
      />
      <nav
        aria-label="Storefront"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* No max-width. Constraining it centred the bar and left the outer
            tabs adrift on a wide phone, and any horizontal overflow elsewhere
            on the page then pushed the last one out of reach entirely. */}
        <ul className="flex w-full">
          {tabs.map(({ href, label, icon: Icon, badge }) => {
            // The menu tab is the base path, so an exact match — otherwise it
            // would light up on every child route at once.
            const active =
              href === base ? pathname === base : pathname.startsWith(href);
            return (
              <li key={label} className="flex-1">
                <Link
                  href={`${href}${q}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors ${
                    active ? "text-zinc-900" : "text-zinc-400"
                  }`}
                >
                  <span className="relative">
                    <Icon
                      className="h-[22px] w-[22px]"
                      // The active tab is filled, the rest outlined. It reads
                      // faster than colour alone and survives a colourblind
                      // eye and a sunlit screen.
                      strokeWidth={active ? 2.4 : 1.8}
                      fill={active && label === "Rewards" ? "currentColor" : "none"}
                    />
                    {!!badge && badge > 0 && (
                      <span className="absolute -right-1.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                        {badge > 9 ? "9+" : badge}
                      </span>
                    )}
                  </span>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
