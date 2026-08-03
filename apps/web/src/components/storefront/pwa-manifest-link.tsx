"use client";

// Makes a storefront installable as the restaurant's own app.
//
// Injected from the client rather than declared in route metadata because the
// values are per-request: which brand, which logo, and — the part that trips
// people up — which path the storefront actually lives at. On a brand custom
// domain that's "/", on the app domain it's "/order/<slug>". Hardcode either
// and every installed icon on the other host opens a 404.
//
// On iOS this is also load-bearing for notifications: Safari only delivers
// Web Push to a site that has been added to the home screen, and it will only
// offer that properly for a page with a manifest and the apple-mobile-web-app
// meta below.

import { useEffect } from "react";

function upsertLink(rel: string, href: string, id: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[data-oh="${id}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("data-oh", id);
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
}

function upsertMeta(name: string, content: string, id: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[data-oh="${id}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("data-oh", id);
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

export function PwaManifestLink({
  slug,
  brandId,
  name,
  logoUrl,
  themeColor,
}: {
  slug: string;
  brandId?: string | null;
  name?: string | null;
  logoUrl?: string | null;
  themeColor?: string | null;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Where this storefront actually is, from the browser's point of view.
    const start = `${window.location.pathname}${
      brandId ? `?brand=${encodeURIComponent(brandId)}` : ""
    }`;

    const params = new URLSearchParams({ slug, start });
    if (brandId) params.set("brand", brandId);
    if (themeColor && /^#[0-9a-fA-F]{6}$/.test(themeColor)) {
      params.set("theme", themeColor);
    }

    upsertLink("manifest", `/storefront-manifest?${params.toString()}`, "manifest");

    // iOS ignores the manifest's icons for the home-screen tile and uses this.
    if (logoUrl) upsertLink("apple-touch-icon", logoUrl, "apple-icon");

    // Without this, iOS opens the home-screen tile in a Safari tab — which
    // means no standalone display mode and therefore no push.
    upsertMeta("apple-mobile-web-app-capable", "yes", "ios-capable");
    upsertMeta("mobile-web-app-capable", "yes", "web-capable");
    if (name) upsertMeta("apple-mobile-web-app-title", name, "ios-title");
    upsertMeta(
      "apple-mobile-web-app-status-bar-style",
      "default",
      "ios-status-bar",
    );
    if (themeColor && /^#[0-9a-fA-F]{6}$/.test(themeColor)) {
      upsertMeta("theme-color", themeColor, "theme-color");
    }
    // Deliberately not cleaned up on unmount: navigating within the storefront
    // would otherwise strip the manifest mid-session and lose installability
    // exactly when the customer is deciding to install.
  }, [slug, brandId, name, logoUrl, themeColor]);

  return null;
}
