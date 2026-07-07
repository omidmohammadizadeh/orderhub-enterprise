import { NextRequest, NextResponse } from "next/server";

// Phase AW — custom domains for brand storefronts. When a request arrives on a
// brand's own domain (e.g. order.pizzauno.com, routed here via Cloudflare for
// SaaS → our fallback origin), rewrite the root to that brand's storefront
// (/order/<slug>?brand=<id>) so it renders without the address bar changing.
// Primary/app hosts pass straight through. Storefront sub-paths (/order/...)
// already resolve by path on any host, so only the root needs rewriting.

// Absolute API base. NEXT_PUBLIC_API_URL may be unset in the edge-middleware
// bundle (the client can use a relative "/api" proxy), so fall back to the
// known API origin — the middleware can't use a relative URL.
const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.API_PUBLIC_URL ||
  "https://orderhub-api-0re6.onrender.com/api"
).replace(/\/$/, "");

const PRIMARY_HOSTS = (
  process.env.NEXT_PUBLIC_PRIMARY_HOSTS ??
  // Both marketing domains + the app host serve the same Next build; they
  // pass straight through (no storefront rewrite). menumanager.uk is the
  // "Menu Manager"-branded marketing site (the POS website given to Uber).
  "orderhubsolutions.com,www.orderhubsolutions.com,menumanager.uk,www.menumanager.uk"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isPrimaryHost(host: string): boolean {
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".onrender.com") ||
    host.endsWith(".vercel.app") ||
    PRIMARY_HOSTS.includes(host)
  );
}

// Which marketing brand this host renders as. menumanager.uk (+ www) →
// "menumanager"; everything else → "orderhub". Passed downstream as the
// `x-site-brand` request header so server components/metadata don't each
// re-parse the Host.
function siteBrandForHost(host: string): "menumanager" | "orderhub" {
  return host.includes("menumanager") ? "menumanager" : "orderhub";
}

// Tiny in-process cache so we don't hit the API on every request.
const cache = new Map<string, { value: { slug: string; brandId: string } | null; exp: number }>();

async function resolveHost(host: string): Promise<{ slug: string; brandId: string } | null> {
  const hit = cache.get(host);
  if (hit && hit.exp > Date.now()) return hit.value;
  let value: { slug: string; brandId: string } | null = null;
  if (API_URL.startsWith("http")) {
    try {
      const res = await fetch(
        `${API_URL}/v1/brands/public/resolve-host?host=${encodeURIComponent(host)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const json = await res.json();
        if (json && json.slug && json.brandId) value = { slug: json.slug, brandId: json.brandId };
      }
    } catch {
      /* network blip — treat as unresolved, retry next request */
    }
  }
  cache.set(host, { value, exp: Date.now() + 60_000 });
  return value;
}

// Pass the resolved marketing brand downstream on every request so server
// components + generateMetadata can read one header instead of re-parsing.
function withBrand(host: string, res: NextResponse): NextResponse {
  res.headers.set("x-site-brand", siteBrandForHost(host));
  return res;
}

export async function middleware(req: NextRequest) {
  const host = ((req.headers.get("host") ?? "").split(":")[0] ?? "").toLowerCase();
  if (isPrimaryHost(host)) {
    // Forward the brand as a REQUEST header so getSiteBrand() can read it.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-site-brand", siteBrandForHost(host));
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Custom domain. Only the root needs rewriting to the storefront; deeper
  // /order/<slug>/... paths already resolve by path on any host.
  if (req.nextUrl.pathname === "/") {
    const resolved = await resolveHost(host);
    if (resolved && resolved.slug) {
      const url = req.nextUrl.clone();
      url.pathname = `/order/${resolved.slug}`;
      url.searchParams.set("brand", resolved.brandId);
      return withBrand(host, NextResponse.rewrite(url));
    }
  }
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-site-brand", siteBrandForHost(host));
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Skip Next internals, the API proxy, and static files.
  matcher: ["/((?!_next/|api/|favicon.ico|.*\\..*).*)"],
};
