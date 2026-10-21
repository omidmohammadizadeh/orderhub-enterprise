// The storefront's welcome screen — a full-screen picture a phone customer
// sees once when they open the shop's link, with an "Order now" button.
//
// Stored per LOCATION on Location.settings.storefrontSplash (no migration;
// the location PATCH already shallow-merges settings keys). A shop keeps a
// list so occasions can be scheduled ahead: the Christmas one with its dates,
// an everyday one with none. Which one shows is decided here, on the server,
// in the shop's own timezone — the customer's phone clock is not the shop's
// calendar.

export interface StorefrontSplash {
  id: string;
  /** Staff-facing label: "Christmas 2026". */
  name: string;
  imageUrl: string;
  /** Optional live text over the picture. */
  headline?: string | null;
  subline?: string | null;
  /** Inclusive "YYYY-MM-DD" in the location's timezone. Empty = open-ended. */
  startDate?: string | null;
  endDate?: string | null;
  enabled: boolean;
}

export interface PublicSplash {
  id: string;
  imageUrl: string;
  headline: string | null;
  subline: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" for `now` on the shop's wall calendar. */
export function shopToday(timezone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: timezone || "Europe/London" });
}

export function readSplashes(settings: unknown): StorefrontSplash[] {
  const list = (settings as any)?.storefrontSplash?.splashes;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s: any) => s && typeof s.id === "string" && typeof s.imageUrl === "string" && s.imageUrl,
  );
}

/**
 * Today's splash, or null.
 *
 * When several are live, the one with a start date wins over an everyday one
 * with none (an occasion is more specific than the default), and among dated
 * ones the most recently started wins — so "Christmas week" set inside
 * "December" takes over for its week.
 */
export function activeSplash(
  settings: unknown,
  timezone: string,
  now = new Date(),
): PublicSplash | null {
  const today = shopToday(timezone, now);
  const live = readSplashes(settings).filter((s) => {
    if (!s.enabled) return false;
    if (s.startDate && DATE.test(s.startDate) && today < s.startDate) return false;
    if (s.endDate && DATE.test(s.endDate) && today > s.endDate) return false;
    return true;
  });
  if (!live.length) return null;
  live.sort((a, b) => {
    const as = a.startDate && DATE.test(a.startDate) ? a.startDate : "";
    const bs = b.startDate && DATE.test(b.startDate) ? b.startDate : "";
    return bs.localeCompare(as);
  });
  const s = live[0]!;
  return {
    id: s.id,
    imageUrl: s.imageUrl,
    headline: s.headline?.trim() || null,
    subline: s.subline?.trim() || null,
  };
}
