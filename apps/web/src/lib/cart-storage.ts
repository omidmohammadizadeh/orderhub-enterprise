// A saved basket, and when it goes stale.
//
// Both customer-facing baskets — the storefront's and the QR-at-table one —
// live in localStorage so a page refresh, a phone lock, or the round trip
// through a Google sign-in doesn't lose a half-built order. That is worth
// keeping. What wasn't worth keeping is forever: a customer who added two
// pizzas, changed their mind and closed the tab came back DAYS later to find
// those pizzas still in the basket, at prices the shop may since have
// changed, from a menu that may since have dropped them.
//
// So a basket now expires twelve hours after it was last touched.
//
//   • Last TOUCHED, not first created. Somebody still picking at a basket an
//     hour ago is mid-order; the clock restarts on every change, which the
//     save-on-change effects give us for free. Re-opening the page counts as
//     a touch too, because hydrating the basket back into state fires that
//     same save — so a customer who keeps coming back to think about it keeps
//     their basket, and one who never returns loses it. That is the right way
//     round.
//   • A basket with no timestamp — written by the build before this one — is
//     of unknown age, which is exactly the thing this file exists not to
//     trust. It is treated as expired. The cost is that a customer holding a
//     live basket at the moment this ships loses it once; the alternative is
//     keeping every stale basket already out there for another half a day.
//   • Every read and write is wrapped. Private mode, a full quota and a
//     corrupt entry all have to end in "start with an empty basket", never
//     in a storefront that won't render.
//
// There is deliberately no server side to this. A basket is not an order —
// nothing is reserved, nothing is owed — and a localStorage key the customer
// can clear themselves is the right weight for it.

/** How long a basket survives without being touched. */
export const CART_TTL_MS = 12 * 60 * 60 * 1000;

interface StoredCart<T> {
  /** Bumped only if the shape below ever changes incompatibly. */
  v: 1;
  /** Epoch ms of the last write. */
  savedAt: number;
  lines: T[];
}

function parse<T>(raw: string | null): StoredCart<T> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    // A bare array is the old format: lines, with no idea how old they are.
    if (Array.isArray(value)) return null;
    if (
      value &&
      typeof value === "object" &&
      Array.isArray(value.lines) &&
      typeof value.savedAt === "number"
    ) {
      return value as StoredCart<T>;
    }
  } catch {
    /* corrupt entry — same answer as no entry */
  }
  return null;
}

export interface LoadedCart<T> {
  lines: T[];
  /**
   * When the returned basket was last written, or null when there wasn't a
   * usable one. The page keeps this to time the open-tab check below without
   * having to ask storage again.
   */
  savedAt: number | null;
}

/**
 * The saved basket for this key, or an empty one when there isn't a usable
 * one. An entry past its twelve hours is removed on the way past, so a
 * customer who never comes back doesn't leave it sitting there.
 */
export function loadCart<T>(
  key: string,
  now: number = Date.now(),
): LoadedCart<T> {
  const empty: LoadedCart<T> = { lines: [], savedAt: null };
  if (typeof window === "undefined") return empty;

  let stored: StoredCart<T> | null = null;
  try {
    stored = parse<T>(window.localStorage.getItem(key));
  } catch {
    return empty; // storage blocked entirely
  }

  if (!stored) {
    // Missing, corrupt, or the old untimestamped format. Clear either way:
    // leaving an unreadable entry behind would have us re-decide this on
    // every single page load.
    clearCart(key);
    return empty;
  }

  if (now - stored.savedAt > CART_TTL_MS) {
    clearCart(key);
    return empty;
  }

  return { lines: stored.lines, savedAt: stored.savedAt };
}

/**
 * Save the basket and restart its clock. An empty basket removes the entry
 * rather than storing `[]` — there is nothing to come back to.
 */
export function saveCart<T>(
  key: string,
  lines: T[],
  now: number = Date.now(),
): void {
  if (typeof window === "undefined") return;
  if (!lines.length) {
    clearCart(key);
    return;
  }
  try {
    const payload: StoredCart<T> = { v: 1, savedAt: now, lines };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / private mode — the basket still works for this visit */
  }
}

export function clearCart(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing we can do, and nothing that should break the page */
  }
}

/**
 * Has a basket last touched at `touchedAt` run out of time?
 *
 * For the tab somebody left open. Hydration only runs on mount, so a page
 * sitting in a background tab overnight still holds its basket in memory
 * long after the stored copy died; the pages call this when they come back
 * to the foreground.
 *
 * It takes a timestamp rather than reading storage, deliberately. Asking
 * storage whether the entry is still there conflates "expired" with "never
 * written" — and in private browsing every write fails silently, so the
 * entry is NEVER there. That version would have wiped a private-mode
 * customer's basket every time they switched tabs.
 */
export function cartIsStale(
  touchedAt: number | null,
  now: number = Date.now(),
): boolean {
  if (touchedAt === null) return false; // nothing to judge — leave it alone
  return now - touchedAt > CART_TTL_MS;
}
