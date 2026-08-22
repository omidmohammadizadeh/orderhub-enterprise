// Delivery zone matching — ONE implementation, shared by every surface that
// quotes a delivery fee.
//
// This lives in @orderhub/shared rather than in the API because the storefront
// matches zones client-side (to show the fee before checkout) and the API
// re-matches them server-side (so a tampered cart can't pick its own fee). Those
// two had drifted into separate implementations, along with a third in the POS
// lookup and a fourth in the WhatsApp bot; a shop could be quoted one fee in the
// cart and charged another at checkout. There is now one set of pure functions
// and four callers.
//
// ── The three modes ─────────────────────────────────────────────────────────
//
//   POSTCODE  the UK model. Longest matching prefix wins, so "SW1" and "SW1A"
//             can coexist and the specific one takes precedence.
//   RADIUS    distance bands in miles, measured straight-line from the shop.
//   AREA      the Gulf model. Dubai has no usable postcodes — addresses are
//             named communities (Dubai Marina, JLT, Business Bay) — so the
//             operator lists the areas they deliver to and the customer picks
//             one. Matching is EXACT on the picked name, never fuzzy: the list
//             the customer chooses from is the operator's own zone list, so
//             there is no such thing as a mistyped area.
//
// A zone set uses exactly one mode. The mode is derived from the rows rather
// than stored in a flag, so the editor can never disagree with what is actually
// quoting fees.

export type DeliveryZoneMode = "AREA" | "RADIUS" | "POSTCODE" | "NONE";

/** The subset of a DeliveryZone row that matching cares about. Loose about
 *  number vs string because Prisma serialises Decimal columns to strings over
 *  the wire and the storefront gets them in that shape. */
export interface ZoneLike {
  id?: string;
  areaName?: string | null;
  postcodePrefix?: string | null;
  maxDistanceMiles?: number | string | null;
  fee: number | string;
  minOrderValue?: number | string | null;
  isActive?: boolean;
}

export interface ZoneMatch {
  mode: DeliveryZoneMode;
  matched: boolean;
  /** AREA mode only — the customer named an area this shop does not serve.
   *  Distinct from `!matched`, which also covers "they haven't picked yet". */
  unserviceable: boolean;
  zoneId?: string;
  /** Human-readable, for the cart line and the receipt. */
  label?: string;
  areaName?: string;
  postcodePrefix?: string;
  fee: number;
  minOrderValue: number | null;
  /** RADIUS mode only. */
  distanceMiles?: number;
  /** RADIUS mode only — past the furthest band, paying the top rate. */
  beyondLastBand?: boolean;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

export function normalisePostcode(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "");
}

/**
 * Fold an area name to a comparable key.
 *
 * Gulf place names arrive spelled several ways for the same place — "Al Barsha"
 * and "Barsha", "Jumeirah Lake Towers" and "Jumeirah Lakes Towers" — so an
 * exact string compare would refuse delivery to an area the shop plainly
 * serves. Case, punctuation and the Arabic definite article are all dropped;
 * word order and spelling are not, because guessing past that is how a
 * customer ends up charged for the wrong zone.
 */
export function normaliseAreaName(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ") // keep Arabic script intact
    .trim()
    .split(/\s+/)
    .filter((t, i) => !(i === 0 && (t === "al" || t === "the")))
    .join(" ");
}

const activeZones = (zones: ZoneLike[]): ZoneLike[] =>
  zones.filter((z) => z.isActive !== false);

/**
 * Which model this zone set uses.
 *
 * Precedence matters when rows disagree — which the API forbids on write, but
 * old data and hand-edited rows exist. Area beats radius beats postcode: the
 * more specific, operator-stated intent wins over one inferred from geography.
 */
export function zoneMode(zones: ZoneLike[]): DeliveryZoneMode {
  const live = activeZones(zones);
  if (live.some((z) => z.areaName)) return "AREA";
  if (live.some((z) => z.maxDistanceMiles != null)) return "RADIUS";
  if (live.some((z) => z.postcodePrefix)) return "POSTCODE";
  return "NONE";
}

/** The areas this shop delivers to, in display order — this IS the customer's
 *  picker, so it is deliberately the operator's own text, not a gazetteer. */
export function areaZoneNames(zones: ZoneLike[]): string[] {
  return activeZones(zones)
    .map((z) => (z.areaName ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function matchAreaZone(
  zones: ZoneLike[],
  area: string | null | undefined,
): ZoneLike | null {
  const key = normaliseAreaName(area);
  if (!key) return null;
  return (
    activeZones(zones).find((z) => normaliseAreaName(z.areaName) === key) ?? null
  );
}

/** Longest matching prefix wins, so a broad "SW1" and a specific "SW1A" can
 *  coexist and the specific one takes precedence. */
export function matchPostcodeZone(
  zones: ZoneLike[],
  postcode: string | null | undefined,
): ZoneLike | null {
  const pc = normalisePostcode(postcode);
  if (!pc) return null;
  let best: ZoneLike | null = null;
  let bestLen = -1;
  for (const z of activeZones(zones)) {
    // Radius and area rows carry no prefix. Reading .toUpperCase() straight
    // off this used to throw on the storefront the moment a brand switched to
    // distance bands.
    if (!z.postcodePrefix) continue;
    const zp = normalisePostcode(z.postcodePrefix);
    if (zp && pc.startsWith(zp) && zp.length > bestLen) {
      best = z;
      bestLen = zp.length;
    }
  }
  return best;
}

/**
 * Which band a distance falls in.
 *
 * Bands are outer edges: 3.0 then 4.0 means 0–3 miles and 3–4 miles. The
 * smallest band that still covers the distance wins.
 *
 * Past the furthest band we charge the TOP band rather than refusing. That
 * matches the rule already agreed for unrecognised postcodes — an order that
 * quotes nothing is an order that goes out with no delivery fee charged, which
 * is the failure that costs the shop money. `beyondLastBand` is set so the UI
 * can say so.
 */
export function resolveRadiusBand<T extends { maxDistanceMiles?: unknown }>(
  bands: T[],
  distanceMiles: number,
): { band: T; beyondLastBand: boolean } | null {
  const sorted = [...bands]
    .filter((b) => b.maxDistanceMiles != null)
    .sort((x, y) => Number(x.maxDistanceMiles) - Number(y.maxDistanceMiles));
  if (!sorted.length) return null;
  const hit = sorted.find((b) => distanceMiles <= Number(b.maxDistanceMiles));
  return hit
    ? { band: hit, beyondLastBand: false }
    : { band: sorted[sorted.length - 1]!, beyondLastBand: true };
}

/** Band edges with their lower bound filled in, for labels like "3–4 mi". Only
 *  the outer edge is stored, so ranges are contiguous by construction. */
export function radiusBands<T extends { maxDistanceMiles?: unknown }>(
  zones: T[],
): Array<{ zone: T; from: number; to: number }> {
  return zones
    .filter((z) => z.maxDistanceMiles != null)
    .sort((a, b) => Number(a.maxDistanceMiles) - Number(b.maxDistanceMiles))
    .map((zone, i, arr) => ({
      zone,
      from: i === 0 ? 0 : Number(arr[i - 1]!.maxDistanceMiles),
      to: Number(zone.maxDistanceMiles),
    }));
}

const NO_MATCH: ZoneMatch = {
  mode: "NONE",
  matched: false,
  unserviceable: false,
  fee: 0,
  minOrderValue: null,
};

const hit = (z: ZoneLike, extra: Partial<ZoneMatch>): ZoneMatch => ({
  mode: "NONE",
  matched: true,
  unserviceable: false,
  zoneId: z.id,
  fee: num(z.fee),
  minOrderValue: z.minOrderValue != null ? num(z.minOrderValue) : null,
  ...extra,
});

/**
 * The single entry point. Give it whatever you know about the customer and it
 * picks the mode and the row.
 *
 * `distanceMiles` is passed IN rather than computed here because measuring it
 * needs a geocoder, which is I/O — this module stays pure so the storefront can
 * run the identical logic in the browser.
 */
export function resolveZone(
  zones: ZoneLike[],
  customer: {
    postcode?: string | null;
    area?: string | null;
    distanceMiles?: number | null;
  },
): ZoneMatch {
  const live = activeZones(zones);
  const mode = zoneMode(live);
  if (mode === "NONE") return NO_MATCH;

  if (mode === "AREA") {
    if (!normaliseAreaName(customer.area)) {
      // Nothing picked yet. Not a refusal — the cart just has no fee to show.
      return { ...NO_MATCH, mode };
    }
    const z = matchAreaZone(live, customer.area);
    if (!z) {
      // The operator's zone list IS the picker, so an area that isn't on it
      // means "we don't deliver there" — not a typo to be priced around.
      return { ...NO_MATCH, mode, unserviceable: true };
    }
    return hit(z, {
      mode,
      areaName: z.areaName ?? undefined,
      label: (z.areaName ?? "").trim(),
    });
  }

  if (mode === "RADIUS") {
    const bands = radiusBands(live);
    if (!bands.length) return { ...NO_MATCH, mode };
    // No distance means the geocoder failed or nothing has been typed. Charge
    // the top band rather than nothing — same reasoning as beyondLastBand.
    const distance =
      customer.distanceMiles != null && Number.isFinite(customer.distanceMiles)
        ? customer.distanceMiles
        : Number.POSITIVE_INFINITY;
    const band = resolveRadiusBand(live, distance);
    if (!band) return { ...NO_MATCH, mode };
    const edge = bands.find((b) => b.zone === band.band);
    return hit(band.band, {
      mode,
      label: edge ? `${edge.from}–${edge.to} mi` : undefined,
      ...(Number.isFinite(distance)
        ? { distanceMiles: Math.round(distance * 100) / 100 }
        : {}),
      beyondLastBand: band.beyondLastBand,
    });
  }

  const z = matchPostcodeZone(live, customer.postcode);
  if (!z) return { ...NO_MATCH, mode };
  return hit(z, {
    mode,
    postcodePrefix: z.postcodePrefix ?? undefined,
    label: normalisePostcode(z.postcodePrefix),
  });
}

// ── Country conventions ─────────────────────────────────────────────────────

/**
 * Does an address in this country need a postcode to be deliverable?
 *
 * The UAE has no postal code system in everyday use — a Dubai address is
 * building, community, emirate. Requiring one made the storefront's Place
 * Order button permanently disabled for every Gulf customer, which is a harder
 * failure than any pricing bug.
 */
const POSTCODE_COUNTRIES = new Set(["GB", "IE", "US"]);

export function postcodeRequiredFor(country: string | null | undefined): boolean {
  return POSTCODE_COUNTRIES.has(String(country ?? "GB").trim().toUpperCase());
}

/** Miles for the UK and the US, kilometres everywhere else. Bands are STORED
 *  in miles (the column shipped that way); this is a display convention only,
 *  converted at the UI edge so there is no second unit to drift. */
const MILE_COUNTRIES = new Set(["GB", "US"]);

export function distanceUnitForCountry(
  country: string | null | undefined,
): "mi" | "km" {
  return MILE_COUNTRIES.has(String(country ?? "GB").trim().toUpperCase())
    ? "mi"
    : "km";
}

export const KM_PER_MILE = 1.609344;

export const milesToKm = (mi: number): number => mi * KM_PER_MILE;
export const kmToMiles = (km: number): number => km / KM_PER_MILE;

/** Format a stored (miles) distance in whatever unit the country reads in. */
export function formatDistance(
  miles: number,
  country: string | null | undefined,
): string {
  const unit = distanceUnitForCountry(country);
  const v = unit === "km" ? milesToKm(miles) : miles;
  return `${Math.round(v * 10) / 10} ${unit}`;
}

/** What the zone editor should call a zone, given the country. Dubai operators
 *  think in communities; UK operators think in postcodes. */
export function defaultZoneModeForCountry(
  country: string | null | undefined,
): "AREA" | "POSTCODE" {
  return postcodeRequiredFor(country) ? "POSTCODE" : "AREA";
}
