// Small, pure helpers for the live delivery tracker.

export type LatLng = { lat: number; lng: number };

const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function milesBetween(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Minutes until the driver is at the door. Roads wind, so the straight line
 * is stretched by 1.3 and driven at an urban 15 mph, plus a minute to park
 * and walk up. Rounded up, never below one: "0 min" reads as a bug.
 */
export function etaMinutes(driver: LatLng, destination: LatLng): number {
  const miles = milesBetween(driver, destination) * 1.3;
  return Math.max(1, Math.ceil((miles / 15) * 60 + 1));
}

/** Compass bearing from a to b, 0 = north, for turning the driver marker. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** "just now" / "12s ago" / "3 min ago" for the live indicator. */
export function agoLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}
