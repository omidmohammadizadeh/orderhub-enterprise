import type { Metadata } from "next";
import { storefrontMetadata } from "@/lib/storefront-metadata";
import StorefrontClient from "./storefront-client";

// Phase BS — this route is a server component ONLY so it can export
// generateMetadata. The whole storefront UI still runs on the client and is
// unchanged; it lives in ./storefront-client and resolves slug + ?brand=
// from useParams/useSearchParams exactly as it did when it was this file.
//
// Nothing is fetched here for the page itself — the client's react-query
// load of /v1/ordering/store/<slug> is untouched, so the page renders on the
// same single request it always did. generateMetadata's fetch is a separate,
// cached, much smaller read that never blocks it.

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  // ?brand= REPLACES the storefront's identity — name, menu and logo all come
  // from the brand — so the metadata has to be resolved for the same brand
  // the customer is about to see, or a shared link previews the wrong shop.
  const brand = query.brand;
  const brandId = (Array.isArray(brand) ? brand[0] : brand)?.trim() || undefined;
  return storefrontMetadata(slug, brandId);
}

export default function OrderPageRoute() {
  return <StorefrontClient />;
}
