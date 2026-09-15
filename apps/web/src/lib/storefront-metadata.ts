import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";

/**
 * Per-shop <head> for the ordering storefront.
 *
 * Until this existed, every shop's storefront inherited the site-wide
 * metadata from app/layout.tsx, so Google and — the part that actually hurt —
 * every link preview a shop pasted into WhatsApp, Facebook or a text message
 * showed our B2B pitch ("Omnichannel restaurant integration platform…")
 * instead of the takeaway's own name. Shops paste these links every day.
 *
 * Be realistic about what this buys: a direct storefront is not going to
 * outrank Just Eat, Uber Eats and the map pack for "pizza near me". What it
 * does is win the branded search ("Pizza Uno Pelton"), survive the click from
 * the shop's Google Business Profile, and make a shared link look like the
 * shop instead of like us.
 */

/** Public identity of one storefront — the /seo projection, nothing more. */
export interface StorefrontSeo {
  name: string | null;
  about: string | null;
  cuisine: string | null;
  city: string | null;
  postcode: string | null;
  image: string | null;
  /** The shop HAS a banner, but stored as bytes only we can serve. */
  hasStoredImage?: boolean;
  customDomain: string | null;
  directOrderingEnabled: boolean;
  hasMenu: boolean;
}

/**
 * Absolute API origin for server-side fetches.
 *
 * NEXT_PUBLIC_API_URL is "/api" in production on purpose — browser traffic is
 * proxied through Next's rewrite so it never crosses origins. A relative path
 * is useless from the server, so fall through to the internal service URL and
 * finally the known API origin, exactly as middleware.ts does.
 */
function apiOrigin(): string | null {
  const candidates = [
    process.env.NEXT_PUBLIC_API_URL,
    process.env.API_PUBLIC_URL,
    process.env.API_URL,
    "https://orderhub-api-0re6.onrender.com/api",
  ];
  for (const raw of candidates) {
    const value = (raw ?? "").trim().replace(/\/$/, "");
    if (!value.startsWith("http")) continue;
    // API_URL is the bare service host on Render; the REST surface is /api.
    return value.endsWith("/api") ? value : `${value}/api`;
  }
  return null;
}

/**
 * Fetch one storefront's identity.
 *
 * Cached for five minutes: generateMetadata blocks the HTML, so without this
 * every visitor would wait on an API round-trip before a single byte of the
 * page. Shop names and banners change at operator speed, not visitor speed.
 *
 * Fails soft in every direction. A timeout, a 404 or a bad payload returns
 * null, and the caller falls back to metadata that is generic but never
 * wrong — a slow API must not be able to stop the page rendering.
 */
export async function fetchStorefrontSeo(
  slug: string,
  brandId?: string,
): Promise<StorefrontSeo | null> {
  const origin = apiOrigin();
  if (!origin) return null;

  const url = new URL(`${origin}/v1/ordering/store/${encodeURIComponent(slug)}/seo`);
  if (brandId) url.searchParams.set("brand", brandId);

  try {
    const res = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as StorefrontSeo | null;
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/** The host this request actually arrived on, lowercased, port stripped. */
async function requestHost(): Promise<string | null> {
  const h = await headers();
  // Behind Render's proxy `host` is the internal origin; the customer's real
  // host — which on a custom domain IS the shop's domain — is forwarded.
  const raw = h.get("x-forwarded-host") || h.get("host") || "";
  const host = ((raw.split(",")[0] ?? "").split(":")[0] ?? "").trim().toLowerCase();
  return host || null;
}

/** Collapse whitespace and cut on a word boundary — meta descriptions get truncated anyway. */
function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:\s]+$/, "")}…`;
}

/**
 * A preview image URL a crawler can actually fetch.
 *
 * WhatsApp and Facebook fetch og:image over HTTP by URL, and most shops'
 * banners are base64 data URIs in Postgres rather than URLs — Pizza Uno's is
 * 703KB of one. Those get served as real bytes by the API's preview-image
 * route, addressed here on the CANONICAL origin so the image lives on the
 * same domain as the page sharing it (the /api proxy answers on every host,
 * custom domains included).
 */
function previewImage(
  seo: StorefrontSeo | null,
  canonical: string | null,
  slug: string,
  brandId?: string,
): string | null {
  const direct = (seo?.image ?? "").trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  if (!seo?.hasStoredImage || !canonical) return null;
  const query = brandId ? `?brand=${encodeURIComponent(brandId)}` : "";
  const origin = new URL(canonical).origin;
  return `${origin}/api/v1/ordering/store/${encodeURIComponent(slug)}/preview-image${query}`;
}

/**
 * Where this shop's storefront really lives.
 *
 * The same page answers on the brand's own domain, on our fallback domain and
 * at /order/<slug> on any host. Without one agreed canonical, Google sees
 * three pages and splits the shop's branded-search signal between them.
 *
 * The shop's own verified domain wins whenever it has one — that is the URL
 * on its flyers and its Google Business Profile. Otherwise the page is its
 * own canonical on whatever host it was asked for, which is at least stable.
 */
function canonicalFor(
  seo: StorefrontSeo | null,
  host: string | null,
  slug: string,
  brandId?: string,
): string | null {
  if (seo?.customDomain) return `https://${seo.customDomain}/`;
  if (!host) return null;
  // localhost is a development host, not a canonical anyone should publish.
  const scheme = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const query = brandId ? `?brand=${encodeURIComponent(brandId)}` : "";
  return `${scheme}://${host}/order/${encodeURIComponent(slug)}${query}`;
}

/**
 * Should search engines list this storefront?
 *
 * No when the shop is not selling online — direct ordering switched off, or a
 * storefront with nothing orderable on it. Both are pages a searcher would
 * arrive at and be unable to use, and an empty one is usually a half-finished
 * setup rather than a shop.
 *
 * Being CLOSED is deliberately not part of this. Every shop is closed most of
 * the day; dropping them out of the index each night and asking to be
 * re-crawled each morning would be far worse than listing a shut shop.
 */
function indexable(seo: StorefrontSeo | null): boolean {
  if (!seo) return false;
  return seo.directOrderingEnabled && seo.hasMenu;
}

/** Build the storefront's metadata. Never throws; degrades to safe generic copy. */
export async function storefrontMetadata(
  slug: string,
  brandId?: string,
): Promise<Metadata> {
  const [seo, host] = await Promise.all([
    fetchStorefrontSeo(slug, brandId),
    requestHost(),
  ]);

  const name = seo?.name?.trim() || null;
  const cuisine = seo?.cuisine?.trim() || null;
  const town = seo?.city?.trim() || null;

  // Cuisine reads better than a town when we have it ("Pizza Uno — Order
  // Online | Italian"); the town is the fallback because it is the word a
  // customer is most likely to have typed alongside the shop's name.
  const qualifier = cuisine ?? town;
  const title = name
    ? `${name} — Order Online${qualifier ? ` | ${qualifier}` : ""}`
    : "Order Online";

  // The shop's own words when it has written any. The generated fallback is
  // deliberately plain: it has to stay grammatical for a cuisine of "Chinese"
  // and one of "Pizza & Kebabs", so the cuisine sits in its own clause rather
  // than being wedged in front of the word "food".
  const where = [town, seo?.postcode?.trim()].filter(Boolean).join(", ");
  // The dash introduces the cuisine, so it only appears when there is one —
  // "Half Set Up Takeaway — in Newcastle" is not a sentence.
  const detail = `${cuisine ? ` — ${cuisine}` : ""}${where ? ` in ${where}` : ""}`;
  const description = seo?.about?.trim()
    ? clamp(seo.about, 155)
    : name
      ? clamp(`Order online from ${name}${detail}. Delivery or collection.`, 155)
      : "Order food online for delivery or collection.";

  const canonical = canonicalFor(seo, host, slug, brandId);
  const image = previewImage(seo, canonical, slug, brandId);

  return {
    // `absolute` escapes the root layout's "%s · Order Hub" template. Without
    // it the shop's own name would still be trailed by ours in every tab,
    // every search result and every link preview — the exact problem this
    // whole file exists to fix.
    title: { absolute: title },
    description,
    // Lets Next resolve any relative URL below, and silences its warning.
    ...(canonical ? { metadataBase: new URL(canonical) } : {}),
    ...(canonical ? { alternates: { canonical } } : {}),
    robots: indexable(seo)
      ? { index: true, follow: true }
      : { index: false, follow: true },
    openGraph: {
      type: "website",
      siteName: name ?? undefined,
      title,
      description,
      ...(canonical ? { url: canonical } : {}),
      ...(image ? { images: [{ url: image, alt: name ?? "Menu" }] } : {}),
    },
    twitter: {
      // A banner is the whole point of the preview — show it big.
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}
