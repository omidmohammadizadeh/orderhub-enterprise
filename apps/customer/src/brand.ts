import Constants from "expo-constants";

export type Brand = {
  slug: string;
  name: string;
  brandId: string;
  locationId: string | null;
  storefrontUrl: string;
  apiUrl: string;
  primaryColor: string;
  backgroundColor: string;
  /** One app, several shops: the customer picks one (src/shop.ts), which
   *  then rewrites storefrontUrl and locationId above for the session. */
  multiShop?: boolean;
  /** This Android build has a Google Maps key, so the live map can draw. */
  androidMap?: boolean;
  /** Native sign-in this build offers (app.config.ts → brands/<slug>.json). */
  signIn?: {
    apple: boolean;
    google: { iosClientId: string | null; webClientId: string; android: boolean } | null;
  };
};

// Baked in by app.config.ts from brands/<slug>.json.
export const brand = Constants.expoConfig?.extra?.brand as Brand;

export const easProjectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId;

export const appId: string =
  Constants.expoConfig?.ios?.bundleIdentifier ?? Constants.expoConfig?.android?.package ?? brand.slug;

// Plain string parsing rather than URL: React Native's URL is incomplete
// (searchParams.get throws "not implemented" on some versions).
export const storefrontOrigin = brand.storefrontUrl.match(/^https?:\/\/[^/?#]+/)?.[0] ?? brand.storefrontUrl;
const brandPin = brand.storefrontUrl.match(/[?&]brand=([^&#]+)/)?.[1] ?? null;

/** A relative storefront path (what a push carries in data.url) → a full URL
 *  on this brand's storefront host. Anything that isn't a plain relative path
 *  falls back to the storefront home, so a push can't point the app off-site. */
export function storefrontUrlFor(path?: string | null): string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return brand.storefrontUrl;
  return `${storefrontOrigin}${path}`;
}

/** The storefront's ?brand= pin, carried onto paths we build ourselves so the
 *  page shows this brand rather than the shop's default one. */
export function withBrandQuery(path: string): string {
  if (!brandPin || /[?&]brand=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}brand=${brandPin}`;
}
