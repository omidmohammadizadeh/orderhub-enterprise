// UK postcodes → a point on the map, via the free postcodes.io API (runs in
// the browser; no key). Full postcodes ("NE1 4ST") and districts ("NE1") both
// work: a district resolves to its centre.

const FULL = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
const DISTRICT = /^[A-Z]{1,2}\d[A-Z\d]?$/;

/** "ne14st" → "NE1 4ST"; "ne1" → "NE1"; anything else → null. */
export function normalisePostcode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const full = FULL.exec(compact);
  if (full) return `${full[1]} ${full[2]}`;
  if (DISTRICT.test(compact)) return compact;
  return null;
}

export type GeocodeResult =
  | { ok: true; lat: number; lng: number; postcode: string; area: string | null }
  | { ok: false; reason: "invalid" | "not-found" | "network" };

type PostcodesIoResult = {
  latitude: number | null;
  longitude: number | null;
  postcode?: string;
  outcode?: string;
  admin_district?: string | string[] | null;
};

function areaOf(r: PostcodesIoResult): string | null {
  const d = r.admin_district;
  if (Array.isArray(d)) return d[0] ?? null;
  return d ?? null;
}

export async function geocodePostcode(raw: string, signal?: AbortSignal): Promise<GeocodeResult> {
  const postcode = normalisePostcode(raw);
  if (!postcode) return { ok: false, reason: "invalid" };
  const isDistrict = !postcode.includes(" ");
  const url = isDistrict
    ? `https://api.postcodes.io/outcodes/${encodeURIComponent(postcode)}`
    : `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`;
  try {
    const res = await fetch(url, { signal });
    if (res.status === 404) return { ok: false, reason: "not-found" };
    if (!res.ok) return { ok: false, reason: "network" };
    const json = (await res.json()) as { result?: PostcodesIoResult | null };
    const r = json.result;
    if (!r || r.latitude == null || r.longitude == null) return { ok: false, reason: "not-found" };
    return { ok: true, lat: r.latitude, lng: r.longitude, postcode, area: areaOf(r) };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, reason: "network" };
  }
}

/** The nearest postcode to a point, for labelling "your location". Best effort. */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.postcodes.io/postcodes?lon=${encodeURIComponent(lng)}&lat=${encodeURIComponent(lat)}&limit=1`,
      { signal },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: Array<{ postcode: string }> | null };
    return json.result?.[0]?.postcode ?? null;
  } catch {
    return null;
  }
}
