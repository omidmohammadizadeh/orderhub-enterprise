import { NextResponse } from "next/server";

// The restaurant's own app icon on the customer's home screen.
//
// A web app manifest is what turns a storefront into something installable —
// and on iOS it is a hard prerequisite for Web Push: Safari only delivers
// push to a site that has been added to the home screen. So this file is not
// cosmetic; without it there is no push on iPhone at all.
//
// It is a route rather than Next's static `app/manifest.ts` because the
// content is per-restaurant. One binary, a hundred storefronts, a hundred
// different icons and names — which is precisely the white-label story that
// native apps make so expensive.

/** Fall back to the OrderHub mark, which is a known-good 512×512 PNG. Android
 *  refuses to treat a site as installable without an icon of at least 192px,
 *  so there always has to be one we can vouch for. */
const FALLBACK_ICON = "/orderhub-logo.png";

/** TenantBranding.primaryColor's default — the orange the storefront already
 *  wears when a brand hasn't picked anything. */
const DEFAULT_THEME = "#f97316";

/**
 * start_url and scope must be same-origin, and this value comes off a query
 * string, so treat it as untrusted: anything that isn't a plain relative path
 * is discarded rather than sanitised. "//evil.com" is a protocol-relative URL,
 * not a path, which is why the second character is checked too.
 */
function safePath(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

function apiBase(requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  // "/api" is the browser-side default (it goes through the Next rewrite).
  // Server-side there is no relative fetch, so resolve it against this
  // request's own origin.
  if (!configured || configured.startsWith("/")) {
    return new URL(configured ?? "/api", requestUrl).toString().replace(/\/$/, "");
  }
  return configured.replace(/\/$/, "");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const brand = url.searchParams.get("brand");

  const defaultStart = slug
    ? `/order/${encodeURIComponent(slug)}${brand ? `?brand=${encodeURIComponent(brand)}` : ""}`
    : "/";
  // The page tells us where it lives, because that differs by host: on a brand
  // custom domain the storefront is at "/", on the app domain it's at
  // /order/<slug>. Guessing wrong sends every installed icon to a 404.
  const start = safePath(url.searchParams.get("start"), defaultStart);
  const scope = safePath(url.searchParams.get("scope"), "/");

  let name = "Order online";
  let icon: string | null = null;
  let theme = DEFAULT_THEME;

  if (slug) {
    try {
      const res = await fetch(
        `${apiBase(request.url)}/v1/ordering/store/${encodeURIComponent(slug)}${
          brand ? `?brand=${encodeURIComponent(brand)}` : ""
        }`,
        // The name and logo change about once a year; re-fetching them on
        // every install check is waste. Manifests are also requested early in
        // page load, so this sits on a path worth keeping cheap.
        { next: { revalidate: 3600 } },
      );
      if (res.ok) {
        const data = await res.json();
        name = data?.brand?.name ?? data?.location?.name ?? name;
        icon = data?.brand?.logoUrl ?? data?.location?.logoUrl ?? null;
      }
    } catch {
      // A manifest that falls back to sensible defaults still installs. An
      // exception here would return a 500 and make the site un-installable,
      // which is a far worse outcome than a generic icon.
    }
  }

  const themeParam = url.searchParams.get("theme");
  if (themeParam && /^#[0-9a-fA-F]{6}$/.test(themeParam)) theme = themeParam;

  const icons = [
    // The brand's logo first so it wins on platforms that take the first
    // usable match. Sizes are declared rather than measured — we can't inspect
    // a remote image here — which is exactly why the guaranteed 512×512
    // fallback below stays in the list.
    ...(icon
      ? [
          { src: icon, sizes: "512x512", type: "image/png", purpose: "any" },
          { src: icon, sizes: "192x192", type: "image/png", purpose: "any" },
        ]
      : []),
    { src: FALLBACK_ICON, sizes: "512x512", type: "image/png", purpose: "any" },
  ];

  return NextResponse.json(
    {
      name,
      short_name: name.length > 12 ? `${name.slice(0, 12).trim()}…` : name,
      description: `Order online from ${name}`,
      start_url: start,
      scope,
      display: "standalone",
      orientation: "portrait",
      theme_color: theme,
      background_color: "#ffffff",
      icons,
      categories: ["food", "shopping"],
    },
    {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
