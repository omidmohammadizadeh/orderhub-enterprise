"use client";

// Sticky category tabs for the storefront menu.
//
// The tabs are a table of contents, not a filter: the whole menu stays on the
// page and a tab scrolls to its section, the way Deliveroo and Uber Eats work.
// A filter hides everything else, so the customer who tapped "Pizzas" never
// scrolls past the sides they would have added.
//
// Scroll-spy reads section positions on scroll (one rAF per frame) rather than
// an IntersectionObserver: "which section is under the tabs" is a position
// question, and an observer only reports crossings, which goes wrong for a
// section shorter than the viewport that is skipped in one fling.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type CategoryTab = { id: string; label: string };

/** DOM id of a menu section, shared by the tabs and the page. */
export const sectionDomId = (tabId: string) => `category-${tabId}`;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Tracks which section sits under the sticky bar, and scrolls to one on
 * request. While a tap-triggered smooth scroll is running the spy is held on
 * the target, so the highlight doesn't flick through every tab on the way.
 */
const useScrollSpy = (ids: string[], getOffset: () => number) => {
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);
  const lockedUntil = useRef(0);

  useEffect(() => {
    if (ids.length === 0) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (Date.now() < lockedUntil.current) return;
      const line = getOffset() + 8;
      let current = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(sectionDomId(id));
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      // At the very bottom the last section may never reach the line.
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 4;
      setActiveId(atBottom ? (ids[ids.length - 1] ?? current) : current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids, getOffset]);

  const scrollTo = useCallback(
    (id: string) => {
      const el = document.getElementById(sectionDomId(id));
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - getOffset();
      const instant = prefersReducedMotion();
      setActiveId(id);
      // Held until the page stops (scrollend), with a ceiling for browsers
      // that don't fire it — a long jump can outlast any fixed guess.
      lockedUntil.current = instant ? 0 : Date.now() + 2000;
      if (!instant) {
        window.addEventListener(
          "scrollend",
          () => {
            lockedUntil.current = 0;
          },
          { once: true },
        );
      }
      window.scrollTo({ top, behavior: instant ? "auto" : "smooth" });
    },
    [getOffset],
  );

  const isJumping = useCallback(() => Date.now() < lockedUntil.current, []);

  return { activeId, scrollTo, isJumping };
};

type CategoryTabsProps = {
  tabs: CategoryTab[];
  /** Sticky offset from the top of the viewport, in px (the header height). */
  stickyTop: number;
};

export const CategoryTabs = ({ tabs, stickyTop }: CategoryTabsProps) => {
  const barRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const getOffset = useCallback(
    () => stickyTop + (barRef.current?.offsetHeight ?? 52),
    [stickyTop],
  );
  const ids = useStableIds(tabs);
  const { activeId, scrollTo, isJumping } = useScrollSpy(ids, getOffset);

  // Keep the highlighted tab visible inside the horizontally-scrolling strip.
  // Instant while a tap-triggered page scroll is running: Chrome lets only one
  // programmatic smooth scroll run at a time, so a smooth strip scroll here
  // cancelled the page's and left the customer halfway down the menu.
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.clientWidth / 2 + tab.offsetWidth / 2;
    const smooth = !prefersReducedMotion() && !isJumping();
    if (smooth) strip.scrollTo({ left, behavior: "smooth" });
    else strip.scrollLeft = left;
  }, [activeId, isJumping]);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={barRef}
      className="sticky z-30 -mx-4 border-b border-sf-border bg-sf-bg backdrop-blur supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--sf-bg)_88%,transparent)] sm:mx-0"
      style={{ top: stickyTop }}
    >
      <nav aria-label="Menu categories">
        <div
          ref={stripRef}
          className="flex gap-1 overflow-x-auto px-2 [scrollbar-width:none] sm:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <a
                key={tab.id}
                data-tab={tab.id}
                href={`#${sectionDomId(tab.id)}`}
                aria-current={active ? "location" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  scrollTo(tab.id);
                }}
                className={cn(
                  "relative flex min-h-[48px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-semibold",
                  "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sf-accent",
                  active ? "text-sf-text" : "text-sf-muted hover:text-sf-text",
                )}
              >
                {tab.label}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-sf-accent transition-opacity duration-200",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
};

/** Same array instance until the ids actually change, so the spy's effect
 *  isn't torn down on every parent render. */
const useStableIds = (tabs: CategoryTab[]) => {
  const key = tabs.map((t) => t.id).join("|");
  const ref = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  if (ref.current.key !== key) {
    ref.current = { key, ids: tabs.map((t) => t.id) };
  }
  return ref.current.ids;
};
