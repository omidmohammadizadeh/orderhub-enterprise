// A code's text is unique per SHOP, not per account: two shops in one group
// may each run their own "20OFF" with different terms. What may never happen
// is two codes with the same text valid at the same shop — checkout couldn't
// tell which one the customer meant.
//
// Scope is PromoCode.locationIds: empty = every shop in the account.

/** True when some shop would accept both codes. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  return a.some((l) => b.includes(l));
}

/**
 * Of the codes sharing one text, the one that applies at `locationId`: a code
 * made for that shop first, then an every-shop code. Null when none is valid
 * there. Without a location (old callers), an every-shop code, else the only
 * one there is.
 */
export function pickForLocation<T extends { locationIds: string[] }>(
  rows: T[],
  locationId: string | null | undefined,
): T | null {
  if (!locationId) return rows.find((r) => !r.locationIds.length) ?? (rows.length === 1 ? rows[0]! : null);
  return rows.find((r) => r.locationIds.includes(locationId)) ?? rows.find((r) => !r.locationIds.length) ?? null;
}
