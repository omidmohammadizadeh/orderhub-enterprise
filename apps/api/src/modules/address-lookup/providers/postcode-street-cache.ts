// A postcode's streets do not move.
//
// Every lookup before this cache paid full network price for an answer that
// was already known — and on a phone call that price is paid in silence while
// somebody waits. A takeaway delivers to the same few hundred postcodes over
// and over, so the second caller from a street should be answered from memory.
//
// Deliberately in-process and unbounded in time: the data is public geography,
// it is small, and a restart re-warms it within a service. Capped by count so
// a busy tenant can't grow it without limit.

export interface CachedStreets {
  streets: string[];
  city?: string;
  latitude?: number;
  longitude?: number;
}

const MAX_ENTRIES = Number(process.env.ADDRESS_STREET_CACHE_MAX) || 5000;

const store = new Map<string, CachedStreets>();

function key(postcode: string): string {
  return (postcode ?? "").toUpperCase().replace(/\s+/g, "");
}

export function getCachedStreets(postcode: string): CachedStreets | undefined {
  const k = key(postcode);
  const hit = store.get(k);
  if (!hit) return undefined;
  // Refresh recency so the eviction below drops genuinely cold postcodes.
  store.delete(k);
  store.set(k, hit);
  return hit;
}

export function cacheStreets(postcode: string, value: CachedStreets): void {
  if (!value.streets.length) return; // never cache a failure
  const k = key(postcode);
  store.delete(k);
  store.set(k, value);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Test seam. */
export function clearStreetCache(): void {
  store.clear();
}
