// ── Where a receipt QR points ───────────────────────────────────────────────
//
// Two callers need this and they must not disagree, or the QR the browser
// prints over Bluetooth would open a different storefront from the one the
// API rasterises for a LAN printer:
//
//   - MarketingService.receiptOffer — the browser print path asks for it
//   - PrintJobsService — bakes the raster for server-rendered LAN printers
//
// A pure function rather than a shared service: PrintJobsService cannot inject
// MarketingService without closing the loop
// Printers → Marketing → UberEats → Orders → Printers.

export interface QrUrlBrand {
  onlineOrderingSlug?: string | null;
  directOrderingEnabled?: boolean | null;
  /** Which shop this brand belongs to, when it names one. */
  primaryLocationId?: string | null;
  /** Every shop this brand is served at. */
  locationIds?: string[] | null;
}

export interface QrUrlLocation {
  id?: string | null;
  slug?: string | null;
  brandId?: string | null;
  onlineOrderingSlug?: string | null;
}

export interface QrUrlResult {
  url: string | null;
  /** The brand whose storefront it opens — may not be the order's brand. */
  storefrontBrandId: string;
  /** Why there's no URL, for the log. Empty when there is one. */
  reason: string;
}

export function buildStorefrontQrUrl(args: {
  brandId: string;
  /**
   * The brand the ORDER itself named, if any — as opposed to the one filled in
   * from the location. Only a brand the order actually chose is ever pinned in
   * the URL; see below for why.
   */
  orderBrandId?: string | null;
  brand: QrUrlBrand | null;
  loc: QrUrlLocation | null;
  /** WEB_URL, already trimmed of trailing slashes. */
  base: string;
}): QrUrlResult {
  const { brandId, orderBrandId, brand, loc, base } = args;

  // Whose storefront the QR opens.
  //
  // The order's brand is whatever the channel mapped it to, and for a HubRise
  // connection relaying Uber Eats that is routinely a plumbing brand with no
  // storefront of its own ("Order Hub"). Pointing the QR at it would land the
  // customer on a storefront wearing the wrong name — worse than printing
  // nothing. When the order's brand has no storefront identity, use the
  // location's own brand: the one whose sign is above the door.
  // ...and it must be a brand THIS shop actually serves.
  //
  // Best Kebab's receipt QR opened another restaurant's menu: the order's
  // brand had a storefront slug of its own, so it was trusted, but it belongs
  // to a different location. Having a slug says the brand can be shown; it
  // says nothing about whose door the customer is standing at.
  //
  // Membership is only ENFORCED when we actually know it. A brand that names
  // no location is treated as trusted, because older rows carry neither field
  // and refusing them would drop the QR off receipts that print correctly
  // today. We reject only when the brand positively belongs somewhere else.
  const membershipKnown =
    brand?.primaryLocationId != null || (brand?.locationIds?.length ?? 0) > 0;
  const servesThisShop =
    !loc?.id ||
    !membershipKnown ||
    brandId === loc.brandId ||
    brand?.primaryLocationId === loc.id ||
    (brand?.locationIds ?? []).includes(loc.id);

  const storefrontBrandId =
    brand?.onlineOrderingSlug && servesThisShop
      ? brandId
      : (loc?.brandId ?? brandId);

  // Whether to pin a brand at all.
  //
  // `?brand=` tells the storefront to render THAT brand — its menu and its
  // name — over the location. That is right for a virtual brand the customer
  // actually ordered from, and wrong for anything else.
  //
  // When the order named no brand we used to pin Location.brandId, which on
  // these shops is the tenant's placeholder "Order Hub" brand. Best Kebab's
  // receipt QR therefore opened China Chef's menu under the name "Order Hub"
  // — the placeholder's active menu, at someone else's shop. Confirmed
  // against production: /order/<loc> alone returns the Best Kebab menu and
  // the BEST KEBAB name.
  //
  // So pin only a brand the ORDER chose and that this shop serves. With
  // nothing to pin, the bare location URL is not a fallback — it is the
  // correct answer, and exactly what a customer browsing normally sees.
  // Three conditions, all necessary: the ORDER chose it, this shop serves it,
  // and it has a storefront identity of its own. A HubRise plumbing brand
  // passes the first two and has no storefront at all — pinning it would
  // overlay a nameless brand on the shop.
  const pinnedBrandId =
    orderBrandId && servesThisShop && brand?.onlineOrderingSlug
      ? orderBrandId
      : null;

  if (brand?.directOrderingEnabled && brand?.onlineOrderingSlug && servesThisShop) {
    return {
      url: `${base}/brand/${brand.onlineOrderingSlug}`,
      storefrontBrandId,
      reason: "",
    };
  }

  // Falls back to the location's id. getStorefrontBySlug resolves
  // `OR: [onlineOrderingSlug, slug, id]`, so /order/<id> is a working link —
  // it's how these stores are browsed today. Without the fallback a location
  // that never had a slug typed into it produced no URL, which silently
  // dropped the QR off every marketplace receipt.
  const locSlug = loc?.onlineOrderingSlug ?? loc?.slug ?? loc?.id ?? null;
  if (!locSlug) {
    return {
      url: null,
      storefrontBrandId,
      reason: "no brand slug and no location slug/id",
    };
  }

  return {
    url: pinnedBrandId
      ? `${base}/order/${locSlug}?brand=${encodeURIComponent(pinnedBrandId)}`
      : `${base}/order/${locSlug}`,
    storefrontBrandId,
    reason: "",
  };
}

/**
 * Channels that should get a "scan to order online" QR.
 *
 * Online ordering and WhatsApp are excluded — those customers already order
 * direct. Everything else (Uber Eats, Deliveroo, Just Eat, HubRise relaying
 * any of them) is a marketplace whose customer we'd like back on our own
 * storefront. Mirrors QR_EXCLUDED in apps/web print-order.ts.
 */
const QR_EXCLUDED_SOURCES = new Set([
  "ONLINE",
  "DIRECT",
  "POS",
  "VOICE",
  "WHATSAPP",
  "WHATS_APP",
]);

export function isMarketplaceSource(
  orderSource?: string | null,
  platform?: string | null,
): boolean {
  const src = String(orderSource ?? platform ?? "").toUpperCase();
  if (!src) return false;
  return !QR_EXCLUDED_SOURCES.has(src);
}
