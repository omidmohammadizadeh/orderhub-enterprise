"use client";

// The basket: one shop at a time, as in the app. Kept in this browser so a
// refresh doesn't empty it, and dropped after 12 hours so nobody checks out a
// lunchtime basket at breakfast with yesterday's prices.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SelectedModifier } from "@orderhub/shared";

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type BasketLine = {
  key: string;
  menuItemId: string;
  name: string;
  imageUrl: string | null;
  /** Includes every modifier; quantity is applied on top. */
  unitPrice: number;
  quantity: number;
  modifiers: SelectedModifier[];
  sku: { name: string; plu: string } | null;
  notes?: string;
};

export type BasketShop = { id: string; name: string; area: string | null };

type BasketState = {
  shop: BasketShop | null;
  lines: BasketLine[];
  updatedAt: number;
  /** false = the basket holds another shop's food; the caller asks first. */
  add: (shop: BasketShop, line: Omit<BasketLine, "key">) => boolean;
  replaceWith: (shop: BasketShop, line: Omit<BasketLine, "key">) => void;
  setQuantity: (key: string, quantity: number) => void;
  clear: () => void;
};

/** Two picks are one line when everything the customer chose matches. */
function lineKey(line: Omit<BasketLine, "key">): string {
  const mods = line.modifiers
    .map((m) => `${m.groupId}:${m.id}:${m.parentOptionId ?? ""}`)
    .sort()
    .join("|");
  return [line.menuItemId, line.sku?.plu ?? "", mods, line.notes ?? ""].join("#");
}

export const useBasket = create<BasketState>()(
  persist(
    (set, get) => ({
      shop: null,
      lines: [],
      updatedAt: 0,

      add: (shop, line) => {
        const { shop: current, lines } = get();
        if (current && current.id !== shop.id && lines.length > 0) return false;
        const key = lineKey(line);
        const same = current?.id === shop.id ? lines : [];
        const existing = same.find((l) => l.key === key);
        const next = existing
          ? same.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l))
          : [...same, { ...line, key }];
        set({ shop, lines: next, updatedAt: Date.now() });
        return true;
      },

      replaceWith: (shop, line) => set({ shop, lines: [{ ...line, key: lineKey(line) }], updatedAt: Date.now() }),

      setQuantity: (key, quantity) => {
        const lines = get()
          .lines.map((l) => (l.key === key ? { ...l, quantity } : l))
          .filter((l) => l.quantity > 0);
        set({ lines, shop: lines.length ? get().shop : null, updatedAt: Date.now() });
      },

      clear: () => set({ shop: null, lines: [], updatedAt: Date.now() }),
    }),
    {
      name: "efl.basket",
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ shop, lines, updatedAt }) => ({ shop, lines, updatedAt }),
      merge: (persisted, current) => {
        const p = persisted as Partial<BasketState> | undefined;
        if (!p || Date.now() - (p.updatedAt ?? 0) > MAX_AGE_MS) return current;
        return { ...current, ...p };
      },
      // Read after mount, so the server render and the first client render
      // agree (an empty basket) and nothing flickers into a hydration error.
      skipHydration: true,
    },
  ),
);

let rehydrated = false;
export function rehydrateBasket(): void {
  if (rehydrated) return;
  rehydrated = true;
  void useBasket.persist.rehydrate();
}

export function basketCount(lines: BasketLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function basketSubtotal(lines: BasketLine[]): number {
  return round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
}
