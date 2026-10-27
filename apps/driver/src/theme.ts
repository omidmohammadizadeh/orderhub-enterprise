// One look for the whole driver app: a dark, high-contrast cockpit that reads
// at a glance in a car at night and in sunlight, over a quiet graphite map.
//
// Everything here is plain JS (no native module), so a restyle ships over the
// air to every 1.0.3+ install.

import { Platform } from "react-native";
import Constants from "expo-constants";
import { PROVIDER_GOOGLE } from "react-native-maps";

export const C = {
  bg: "#0A0C0F",
  surface: "#13161B",
  surface2: "#1A1E25",
  surface3: "#232832",
  border: "#262B34",
  borderStrong: "#343A45",
  text: "#F5F7FA",
  textDim: "#A3ACB9",
  textMute: "#65707E",

  go: "#1ED67F", // online / start / positive money
  goDeep: "#0E8F52",
  brand: "#FF7A1A", // Order Hub orange — earnings, highlights
  info: "#3D8BFF", // navigation, links
  warn: "#F5A524",
  danger: "#FF4D4F",
  violet: "#8B7CFF",

  onAccent: "#04140B", // text on the bright green
  overlay: "rgba(5,7,10,0.62)",
  glass: "rgba(19,22,27,0.92)",
} as const;

export const R = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

export const shadow = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  default: { elevation: 10 },
});

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });

// Graphite base map: dark land, slate roads, no POIs or transit, muted labels —
// the route, the driver and the drop-off are the only things that pop.
export const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1b1e23" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7d8693" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1b1e23" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#2a2f37" }] },
  { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
  { featureType: "administrative.neighborhood", stylers: [{ visibility: "off" }] },
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#20242a" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ visibility: "on" }, { color: "#1c2420" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3139" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1b1e23" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e98a5" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#353b45" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#424955" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#b3bcc8" }] },
  { featureType: "road.local", elementType: "labels.text.fill", stylers: [{ color: "#6b7480" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1419" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3d4651" }] },
];

// Store builds always render Google Maps (both keys are EAS secrets). A local
// dev build has no iOS key, so iOS falls back to Apple Maps in dark mode there
// rather than throwing on a missing Google SDK.
const iosGoogleKey = (Constants.expoConfig?.ios?.config as { googleMapsApiKey?: string } | undefined)
  ?.googleMapsApiKey;
const androidGoogleKey = (
  Constants.expoConfig?.android?.config as { googleMaps?: { apiKey?: string } } | undefined
)?.googleMaps?.apiKey;
const useGoogle = Platform.OS === "android" || !!iosGoogleKey || !__DEV__;

// Android has no non-Google map, and Google Maps throws a redbox without a
// key. A keyless local dev build draws a placeholder instead so the rest of
// the app can still be exercised; store builds always have the key.
export const MAP_AVAILABLE = !__DEV__ || Platform.OS !== "android" || !!androidGoogleKey;

export const mapProps = useGoogle
  ? ({ provider: PROVIDER_GOOGLE, customMapStyle: DARK_MAP_STYLE } as const)
  : ({ userInterfaceStyle: "dark", mapType: "mutedStandard", showsPointsOfInterest: false } as const);

export function money(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return `£${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

export function initials(first?: string | null, last?: string | null): string {
  const a = (first ?? "").trim().charAt(0);
  const b = (last ?? "").trim().charAt(0);
  return (a + b).toUpperCase() || "D";
}

// Straight line ×1.3 for winding roads at an urban 15 mph, plus a minute to
// park — the same estimate the customer tracking page shows, so the driver and
// the customer never see two different ETAs.
const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;
export function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.asin(Math.sqrt(h));
}
export function etaMinutes(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const miles = milesBetween(a, b) * 1.3;
  return Math.max(1, Math.ceil((miles / 15) * 60 + 1));
}
