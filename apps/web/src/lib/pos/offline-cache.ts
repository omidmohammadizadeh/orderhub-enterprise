"use client";

// Small lists the till needs with no connection, remembered per location in
// localStorage: the last copy fetched online is served when the fetch fails.
// Bulk data (the menu, the order queue) lives in IndexedDB — idb-storage.ts.

import { deliveryZonesClient, type DeliveryZone } from "@/lib/api/pos.client";

export async function cachedFetch<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  try {
    const value = await fetch();
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full / private mode — the online answer still stands */
    }
    return value;
  } catch (err) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      /* fall through to the original error */
    }
    throw err;
  }
}

/** The location's delivery zones — so a delivery taken offline is still priced. */
export function listZonesCached(locationId: string): Promise<DeliveryZone[]> {
  return cachedFetch(`orderhub-pos:zones:${locationId}`, () =>
    deliveryZonesClient.list(locationId),
  );
}
