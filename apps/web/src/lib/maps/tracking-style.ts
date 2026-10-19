// One look for every live-delivery map: the customer tracking page, the
// dashboard dispatch map and the restaurant apps (apps/customer
// LiveTrackingMap) share this quiet grey base and the same markers, so a
// driver looks the same wherever someone is watching them.

export type LatLng = { lat: number; lng: number };

/** Desaturated base: roads white, land grey, no POIs or transit, so the
 *  route and markers carry the eye. Mirrors apps/customer ANDROID_STYLE. */
export const TRACKING_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#f3f4f6" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f9fafb" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#e5e7eb" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dbeafe" }] },
];

const DARK = "#111827";
const GREEN = "#15803d";

const svgUrl = (svg: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

/** The driver: dark disc, white rim, soft halo, arrow turned to `heading`
 *  (degrees, 0 = north). Green with a tick once they're at the door. */
export function driverIconSvg(heading: number, arrived = false, color = DARK): string {
  const fill = arrived ? GREEN : color;
  const glyph = arrived
    ? `<path d="M23 32.5l6 6 12-13" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M32 19 L41 43 L32 37.5 L23 43 Z" fill="#fff" transform="rotate(${Math.round(heading)} 32 32)"/>`;
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
      `<circle cx="32" cy="32" r="31" fill="${fill}" fill-opacity="0.18"/>` +
      `<circle cx="32" cy="32" r="21.5" fill="#fff"/>` +
      `<circle cx="32" cy="32" r="18.5" fill="${fill}"/>` +
      glyph +
      `</svg>`,
  );
}

/** The customer's door: dark rounded pin with a house. */
export function homeIconSvg(): string {
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="50" viewBox="0 0 44 50">` +
      `<rect x="3" y="2" width="38" height="38" rx="11" fill="#fff"/>` +
      `<rect x="5" y="4" width="34" height="34" rx="9" fill="${DARK}"/>` +
      `<path d="M16 45 L22 49 L28 45 Z" fill="${DARK}"/>` +
      `<path d="M22 12 L32 20.5 H29 V30 H24.5 V24.5 H19.5 V30 H15 V20.5 H12 Z" fill="#fff"/>` +
      `</svg>`,
  );
}

/** The shop the food left from. */
export function shopIconSvg(): string {
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 38 38">` +
      `<circle cx="19" cy="19" r="18" fill="#fff"/>` +
      `<circle cx="19" cy="19" r="15.5" fill="${DARK}"/>` +
      `<rect x="11" y="13" width="16" height="4" rx="1" fill="#fff"/>` +
      `<rect x="12.5" y="17" width="13" height="9" fill="#fff"/>` +
      `<rect x="17" y="20.5" width="4" height="5.5" fill="${DARK}"/>` +
      `</svg>`,
  );
}

const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function milesBetween(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.asin(Math.sqrt(h));
}

/** Minutes to the door: straight line ×1.3 for winding roads at an urban
 *  15 mph, plus a minute to park. Same estimate as the apps. */
export function etaMinutes(driver: LatLng, destination: LatLng): number {
  const miles = milesBetween(driver, destination) * 1.3;
  return Math.max(1, Math.ceil((miles / 15) * 60 + 1));
}

/** Compass bearing a → b, 0 = north. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function agoLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/** A dispatch-map order: the home pin's shape in the order's colour (the
 *  countdown colour, blue when selected, grey once handled), with a short
 *  label — minutes left, a sequence number, ✓ or • — in white. */
export function orderPinSvg(fill: string, text: string, ring = "#fff"): string {
  const safe = text.replace(/[<>&"]/g, "");
  const size = safe.length > 2 ? 11 : 13;
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="50" viewBox="0 0 44 50">` +
      `<rect x="3" y="2" width="38" height="38" rx="11" fill="${ring}"/>` +
      `<rect x="5" y="4" width="34" height="34" rx="9" fill="${fill}"/>` +
      `<path d="M16 45 L22 49 L28 45 Z" fill="${fill}"/>` +
      `<text x="22" y="21" dominant-baseline="central" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${size}" font-weight="800" fill="#fff">${safe}</text>` +
      `</svg>`,
  );
}
