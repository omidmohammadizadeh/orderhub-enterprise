// A point on the map → the address at it, for the storefront's "Use my
// current location" button.
//
// Google first (street number + street, town, postcode, community), because
// it is the only one that names the house. Without a key, UK points still
// get their postcode and town from postcodes.io, and the customer types the
// door. Every field is optional: a partial answer must never blank out
// what the customer already typed.

import { Logger } from "@nestjs/common";

export interface ReverseAddress {
  line1?: string;
  city?: string;
  area?: string;
  postcode?: string;
  latitude: number;
  longitude: number;
}

interface GoogleComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

const TIMEOUT_MS = Number(process.env.ADDRESS_GOOGLE_TIMEOUT_MS) || 2500;
const logger = new Logger("ReverseGeocode");

export function isValidPoint(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Exported for the spec: the Google result → our address. */
export function fromGoogleComponents(
  components: GoogleComponent[],
  latitude: number,
  longitude: number,
): ReverseAddress {
  const pick = (...types: string[]) => {
    for (const t of types) {
      const c = components.find((x) => x.types?.includes(t) && x.long_name?.trim());
      if (c) return c.long_name.trim();
    }
    return undefined;
  };
  const number = pick("street_number");
  const premise = pick("premise");
  const route = pick("route");
  // "14 Grey Street"; a named house: "Rose Cottage, High Street".
  const line1 = number && route ? `${number} ${route}` : [premise, route].filter(Boolean).join(", ");
  const city = pick("postal_town", "locality", "administrative_area_level_2");
  const area = pick("neighborhood", "sublocality_level_1", "sublocality");
  const postcode = pick("postal_code");
  return {
    ...(line1 ? { line1 } : {}),
    ...(city ? { city } : {}),
    ...(area ? { area } : {}),
    ...(postcode ? { postcode } : {}),
    latitude,
    longitude,
  };
}

async function viaGoogle(lat: number, lng: number): Promise<ReverseAddress | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}` +
      `&result_type=street_address|premise|route&key=${key}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`google reverse HTTP ${res.status}`);
  const json: any = await res.json();
  if (json?.status === "ZERO_RESULTS") return null;
  if (json?.status !== "OK") throw new Error(`google reverse ${json?.status}`);
  const first = json.results?.[0];
  if (!first) return null;
  return fromGoogleComponents(first.address_components ?? [], lat, lng);
}

async function viaPostcodesIo(lat: number, lng: number): Promise<ReverseAddress | null> {
  const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&limit=1`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const r = json?.result?.[0];
  if (!r?.postcode) return null;
  const town = Array.isArray(r.admin_district) ? r.admin_district[0] : r.admin_district;
  return { postcode: r.postcode, ...(town ? { city: town } : {}), latitude: lat, longitude: lng };
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseAddress | null> {
  try {
    const hit = await viaGoogle(lat, lng);
    if (hit) return hit;
  } catch (err) {
    logger.warn(`google reverse failed: ${(err as Error).message}`);
  }
  try {
    return await viaPostcodesIo(lat, lng);
  } catch (err) {
    logger.warn(`postcodes.io reverse failed: ${(err as Error).message}`);
    return null;
  }
}
