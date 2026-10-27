// A location's food hygiene rating, as stored and as served.
//
// Stored on Location.settings.hygiene (no migration; the same Json blob the
// location PATCH shallow-merges). Written only by LocationHygieneService —
// on link, on "Refresh now", and by the nightly re-check — so the storefront
// badge follows the FSA by itself when the shop is re-inspected.

import { fsaBusinessUrl, type HygieneResult } from "../../common/fsa-ratings";

export interface StoredHygiene {
  fsaId: string;
  /** As the FSA sends it: "0"–"5", "Pass", "Improvement Required",
   *  "AwaitingInspection", "Exempt", … */
  rating: string;
  ratingDate: string | null;
  /** When we last asked the FSA successfully (ISO). */
  checkedAt: string;
  /** Shown on the storefront. Defaults to true. */
  show: boolean;
}

export interface PublicHygiene {
  rating: string;
  ratingDate: string | null;
  url: string;
}

/** The stored hygiene block, or null when the location has none. */
export function readHygiene(settings: unknown): StoredHygiene | null {
  const h = (settings as any)?.hygiene;
  if (!h || typeof h !== "object" || !h.fsaId) return null;
  return {
    fsaId: String(h.fsaId),
    rating: String(h.rating ?? ""),
    ratingDate: h.ratingDate ? String(h.ratingDate) : null,
    checkedAt: String(h.checkedAt ?? ""),
    show: h.show !== false,
  };
}

/** A fresh FSA result folded into what's stored. The show switch survives a
 *  re-check; a new record (a different fsaId) starts shown. */
export function hygieneFromResult(
  result: HygieneResult,
  previous: StoredHygiene | null,
  now = new Date(),
): StoredHygiene {
  return {
    fsaId: result.establishmentId,
    rating: result.rating,
    ratingDate: result.ratingDate,
    checkedAt: now.toISOString(),
    show: previous ? previous.show : true,
  };
}

/** settings with `hygiene` replaced and every other key kept. */
export function mergeHygiene(settings: unknown, hygiene: StoredHygiene): Record<string, unknown> {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  return { ...base, hygiene };
}

/** What the public storefront payload carries: null when the shop hid it or
 *  has no rating to show. */
export function publicHygiene(settings: unknown): PublicHygiene | null {
  const h = readHygiene(settings);
  if (!h || !h.show || !h.rating) return null;
  return { rating: h.rating, ratingDate: h.ratingDate, url: fsaBusinessUrl(h.fsaId) };
}
