// Pure, isomorphic brand config — NO "use client" here. This module is
// imported by BOTH server code (site-brand.server.ts / getSiteBrand) and
// client code (use-site-brand.ts). A "use client" directive would turn
// these exports into client-reference placeholders on the server, so
// SITE_BRANDS would read as undefined server-side. Keep it plain.
//
// The marketing site serves two domains from one build:
//   • orderhubsolutions.com  → "Order Hub Solutions"
//   • menumanager.uk         → "Menu Manager"  (the POS website given to Uber)

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
