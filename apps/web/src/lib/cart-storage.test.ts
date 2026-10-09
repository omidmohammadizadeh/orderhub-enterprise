import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CART_TTL_MS,
  cartIsStale,
  clearCart,
  loadCart,
  saveCart,
} from "./cart-storage";

// A basket that outlives the customer's appetite is the bug this file fixes:
// two pizzas added on Tuesday, tab closed, and still sitting there on Friday
// at prices the shop may have changed since.
//
// What's pinned here is the timing and the three ways a read has to fail
// safe. The storage stub is hand-rolled rather than jsdom's so this runs in
// the plain node environment, like the other lib tests.

const KEY = "orderhub.cart.pizza-uno";
const LINES = [{ id: "a", name: "Margherita", quantity: 2 }];
const NOON = Date.parse("2026-10-09T12:00:00Z");

function stubStorage(overrides: Partial<Storage> = {}) {
  const map = new Map<string, string>();
  const store: any = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    ...overrides,
  };
  (globalThis as any).window = { localStorage: store };
  return map;
}

let raw: Map<string, string>;
beforeEach(() => {
  raw = stubStorage();
});
afterEach(() => {
  delete (globalThis as any).window;
});

describe("the twelve hours", () => {
  it("gives back a basket saved a moment ago", () => {
    saveCart(KEY, LINES, NOON);
    expect(loadCart(KEY, NOON + 60_000).lines).toEqual(LINES);
  });

  it("hands back when it was saved, for the open-tab check", () => {
    saveCart(KEY, LINES, NOON);
    expect(loadCart(KEY, NOON + 60_000).savedAt).toBe(NOON);
    // Nothing usable stored: no timestamp to judge by either.
    expect(loadCart("orderhub.cart.nobody", NOON).savedAt).toBeNull();
  });

  it("still gives it back at eleven hours, and not at thirteen", () => {
    saveCart(KEY, LINES, NOON);
    expect(loadCart(KEY, NOON + 11 * 3600_000).lines).toEqual(LINES);
    expect(loadCart(KEY, NOON + 13 * 3600_000).lines).toEqual([]);
  });

  it("counts from the last change, not the first item", () => {
    // Somebody still picking at a basket an hour ago is mid-order.
    saveCart(KEY, LINES, NOON);
    const later = NOON + 11 * 3600_000;
    saveCart(KEY, [...LINES, { id: "b", name: "Chips", quantity: 1 }], later);
    expect(loadCart(KEY, later + 11 * 3600_000).lines).toHaveLength(2);
  });

  it("clears the expired entry on the way past", () => {
    saveCart(KEY, LINES, NOON);
    loadCart(KEY, NOON + CART_TTL_MS + 1);
    expect(raw.has(KEY)).toBe(false);
  });
});

describe("a read that can't be trusted ends in an empty basket", () => {
  it("drops the old untimestamped format — its age is unknowable", () => {
    // What the build before this one wrote: bare lines, no savedAt. It could
    // be ten seconds old or ten days; this file exists not to guess.
    raw.set(KEY, JSON.stringify(LINES));
    expect(loadCart(KEY, NOON).lines).toEqual([]);
    expect(raw.has(KEY)).toBe(false);
  });

  it("drops a corrupt entry", () => {
    raw.set(KEY, "{not json");
    expect(loadCart(KEY, NOON).lines).toEqual([]);
  });

  it("survives storage being blocked outright", () => {
    stubStorage({
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
    });
    expect(() => loadCart(KEY, NOON)).not.toThrow();
    expect(loadCart(KEY, NOON).lines).toEqual([]);
  });

  it("survives a full quota on save — this visit still works", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveCart(KEY, LINES, NOON)).not.toThrow();
  });

  it("does nothing at all server-side", () => {
    delete (globalThis as any).window;
    expect(loadCart(KEY, NOON).lines).toEqual([]);
    expect(() => saveCart(KEY, LINES, NOON)).not.toThrow();
    expect(() => clearCart(KEY)).not.toThrow();
  });
});

describe("saving", () => {
  it("removes the entry for an empty basket rather than storing []", () => {
    saveCart(KEY, LINES, NOON);
    saveCart(KEY, [], NOON);
    expect(raw.has(KEY)).toBe(false);
  });
});

describe("cartIsStale — for the tab somebody left open", () => {
  it("goes true at twelve hours since the last touch", () => {
    expect(cartIsStale(NOON, NOON + 60_000)).toBe(false);
    expect(cartIsStale(NOON, NOON + CART_TTL_MS)).toBe(false);
    expect(cartIsStale(NOON, NOON + CART_TTL_MS + 1)).toBe(true);
  });

  it("never judges a basket it has no timestamp for", () => {
    // This is what keeps private browsing safe. Every write fails silently
    // there, so nothing is ever stored — and a version of this that asked
    // storage "is the entry still there?" would wipe a private-mode
    // customer's basket every time they switched tabs.
    expect(cartIsStale(null, NOON + 10 * 24 * 3600_000)).toBe(false);
  });
});
