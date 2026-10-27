import type { Metadata } from "next";
import { ShopPage } from "@/components/eatforless/shop/shop-page";

type Props = { params: Promise<{ listingId: string }> };

// Server-side API origin for metadata only (the page itself loads in the
// browser). Same fallback as the middleware: a relative "/api" can't be
// fetched from the server.
const API_URL = (
  process.env.NEXT_PUBLIC_API_URL?.startsWith("http")
    ? process.env.NEXT_PUBLIC_API_URL
    : process.env.API_PUBLIC_URL || "https://orderhub-api-0re6.onrender.com/api"
).replace(/\/$/, "");

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { listingId } = await params;
  const canonical = `/shop/${encodeURIComponent(listingId)}`;
  try {
    const res = await fetch(`${API_URL}/v1/efl/shops/${encodeURIComponent(listingId)}/menu`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { title: "Shop", alternates: { canonical }, robots: { index: false, follow: true } };
    const data = (await res.json()) as {
      listing?: { description?: string | null; heroImageUrl?: string | null; cuisines?: string[] };
      store?: { brand?: { name?: string } | null; location?: { name?: string; city?: string | null } };
    };
    const name = data.store?.brand?.name || data.store?.location?.name || "Shop";
    const town = data.store?.location?.city;
    const description =
      data.listing?.description ||
      `Order ${data.listing?.cuisines?.slice(0, 2).join(" and ") || "food"} from ${name}${town ? ` in ${town}` : ""} on Eat For Less. Same menu, lower prices.`;
    const image = data.listing?.heroImageUrl;
    return {
      title: name,
      description,
      alternates: { canonical },
      openGraph: { title: `${name} · Eat For Less`, description, url: canonical, ...(image ? { images: [image] } : {}) },
    };
  } catch {
    return { title: "Shop", alternates: { canonical } };
  }
}

export default async function Page({ params }: Props) {
  const { listingId } = await params;
  return <ShopPage listingId={listingId} />;
}
