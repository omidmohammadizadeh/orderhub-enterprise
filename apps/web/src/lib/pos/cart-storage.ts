// Phase AM — POS cart draft persistence.
//
// Stash the in-progress cart + customer details to localStorage on every
// state change so a browser refresh or short network blip doesn't wipe a
// half-built order. Each location gets its own bucket so switching
// locations doesn't cross-contaminate.
//
// We intentionally use localStorage (sync, ~5 MB) rather than IndexedDB.
// The cart payload is tiny and the synchronous API keeps the React state
// update simple. Larger pieces (the menu itself, offline order queue)
// will move to IndexedDB in Phase AN when full offline mode lands.

const KEY_PREFIX = "orderhub:pos:cart:";
const VERSION = 1;

interface Persisted<T> {
  v: number;
  ts: number;
  data: T;
}

export function saveCartDraft<T>(locationId: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const payload: Persisted<T> = { v: VERSION, ts: Date.now(), data };
    window.localStorage.setItem(KEY_PREFIX + locationId, JSON.stringify(payload));
  } catch {
    // Quota exceeded or localStorage disabled — silently ignore, the cart
    // still works in memory.
  }
}

export function loadCartDraft<T>(locationId: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + locationId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted<T>;
    if (parsed?.v !== VERSION) return null;
    // Drop drafts older than 24h so a stale "yesterday" cart doesn't
    // surprise the operator next morning.
    if (Date.now() - parsed.ts > 24 * 60 * 60 * 1000) {
      clearCartDraft(locationId);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function clearCartDraft(locationId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + locationId);
  } catch {
    /* noop */
  }
}
