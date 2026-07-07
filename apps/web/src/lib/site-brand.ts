"use client";

import { useEffect, useState } from "react";

// The public marketing site is served on two domains that share one build:
//   • orderhubsolutions.com  → "Order Hub Solutions"
//   • menumanager.uk         → "Menu Manager"  (the POS website we give Uber)
// Everything user-visible reads its brand from here so a single host check
// rebrands every page. Server components resolve it via getSiteBrand()
// (./site-brand.server); client components use the useSiteBrand() hook here.

export type SiteBrandKey = "orderhub" | "menumanager";

export interface SiteBrand {
  key: SiteBrandKey;
  /** Full legal-ish name, e.g. hero + legal copy. */
  name: string;
  /** Short wordmark shown in the nav / footer. */
  shortName: string;
  /** Primary domain (no scheme). */
  domain: string;
  /** Show the Order Hub POS logo image next to the wordmark. */
  showLogo: boolean;
  /** One-line tagline for <meta description>. */
  tagline: string;
}

export const SITE_BRANDS: Record<SiteBrandKey, SiteBrand> = {
  orderhub: {
    key: "orderhub",
    name: "Order Hub Solutions",
    shortName: "Order Hub",
    domain: "orderhubsolutions.com",
    showLogo: true,
    tagline:
      "Omnichannel restaurant integration platform. Unify Uber Eats, Deliveroo, Just Eat, and direct orders in one place.",
  },
  menumanager: {
    key: "menumanager",
    name: "Menu Manager",
    shortName: "Menu Manager",
    domain: "menumanager.uk",
    showLogo: false,
    tagline:
      "One system for your restaurant — menus, orders, POS and every delivery channel in one place.",
  },
};

/** Map a raw Host header/hostname to a brand. menumanager.uk (+ www) → menumanager. */
export function brandKeyFromHost(host?: string | null): SiteBrandKey {
  const h = (host ?? "").toLowerCase();
  if (h.includes("menumanager")) return "menumanager";
  return "orderhub";
}

/**
 * Client-side brand resolver for Client Components (e.g. the detail-page
 * shell). Reads window.location.hostname after mount. Defaults to Order Hub
 * for SSR/first paint; on menumanager.uk it swaps to Menu Manager on hydrate.
 */
export function useSiteBrand(): SiteBrand {
  const [brand, setBrand] = useState<SiteBrand>(SITE_BRANDS.orderhub);
  useEffect(() => {
    setBrand(SITE_BRANDS[brandKeyFromHost(window.location.hostname)]);
  }, []);
  return brand;
}
