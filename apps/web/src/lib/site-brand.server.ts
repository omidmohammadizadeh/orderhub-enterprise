import "server-only";
import { headers } from "next/headers";
import {
  SITE_BRANDS,
  brandKeyFromHost,
  type SiteBrand,
  type SiteBrandKey,
} from "./site-brand";

export type { SiteBrand } from "./site-brand";

/**
 * Resolve the current request's marketing brand for Server Components and
 * generateMetadata. Reads the `x-site-brand` header the middleware sets,
 * falling back to the Host header. Defaults to Order Hub.
 */
export async function getSiteBrand(): Promise<SiteBrand> {
  const h = await headers();
  const fromHeader = h.get("x-site-brand");
  const key: SiteBrandKey =
    fromHeader === "menumanager" || fromHeader === "orderhub"
      ? (fromHeader as SiteBrandKey)
      : brandKeyFromHost(h.get("host"));
  return SITE_BRANDS[key] ?? SITE_BRANDS.orderhub;
}
