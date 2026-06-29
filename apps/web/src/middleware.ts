import { NextRequest, NextResponse } from "next/server";

// Phase AW — custom domains for brand storefronts. When a request arrives on a
// brand's own domain (e.g. order.pizzauno.com, routed here via Cloudflare for
// SaaS → our fallback origin), rewrite the root to that brand's storefront
// (/order/<slug>?brand=<id>) so it renders without the address bar changing.
// Primary/app hosts pass straight through. Storefront sub-paths (/order/...)
// already resolve by path on any host, so only the root needs rewriting.

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

const PRIMARY_HOSTS = (
  process.env.NEXT_PUBLIC_PRIMARY_HOSTS ??
  "orderhubsolutions.com,www.orderhubsolutions.com"
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

export async function middleware(req: NextRequest) {
  const host = ((req.headers.get("host") ?? "").split(":")[0] ?? "").toLowerCase();
  if (isPrimaryHost(host)) return NextResponse.next();

  // Custom domain. Only the root needs rewriting to the storefront; deeper
  // /order/<slug>/... paths already resolve by path on any host.
  if (req.nextUrl.pathname === "/") {
    const resolved = await resolveHost(host);
    if (resolved && resolved.slug) {
      const url = req.nextUrl.clone();
      url.pathname = `/order/${resolved.slug}`;
      url.searchParams.set("brand", resolved.brandId);
      return NextResponse.rewrite(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  // Skip Next internals, the API proxy, and static files.
  matcher: ["/((?!_next/|api/|favicon.ico|.*\\..*).*)"],
};
