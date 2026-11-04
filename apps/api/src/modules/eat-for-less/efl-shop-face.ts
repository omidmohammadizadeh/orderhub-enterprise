// The name and logo a listing is shown under.
//
// A location can serve several brands and EflListing.brandId says which one
// is listed (Pizza Uno at the "Order Hub" location). The listing has no brand
// relation, only the bare id, so the pinned brands are fetched in one query
// and every place that names a shop goes through shopFace().

export type ShopFace = { name: string | null; logoUrl: string | null };
type BrandRow = { id: string; name: string; logoUrl: string | null };
type FaceListing = {
  brandId?: string | null;
  logoUrl?: string | null;
  location?: { name?: string | null; brand?: { name?: string | null; logoUrl?: string | null } | null } | null;
};

/** The brands the given listings pin, by id. No query when none pin one. */
export async function pinnedBrands(
  prisma: { brand: { findMany: (args: any) => Promise<BrandRow[]> } },
  listings: Array<{ brandId?: string | null }>,
): Promise<Map<string, BrandRow>> {
  const ids = [...new Set(listings.map((l) => l.brandId).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const rows = await prisma.brand.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, logoUrl: true },
  });
  return new Map(rows.map((b) => [b.id, b]));
}

/** The listing's own brand, else the location's brand, else the location.
 *  The listing's own logo upload wins over either brand's. */
export function shopFace(listing: FaceListing, pinned: Map<string, BrandRow>): ShopFace {
  const brand = (listing.brandId && pinned.get(listing.brandId)) || listing.location?.brand || null;
  return {
    name: brand?.name ?? listing.location?.name ?? null,
    logoUrl: listing.logoUrl ?? brand?.logoUrl ?? null,
  };
}

type BannerListing = {
  id: string;
  brandId?: string | null;
  locationId: string;
  heroImageUrl?: string | null;
  location?: { brandId?: string | null } | null;
};
type BannerPrisma = {
  directOrderingConfig: { findMany: (args: any) => Promise<Array<{ brandId: string | null; locationId: string | null; heroImageUrl: string | null }>> };
};

/**
 * The banner a listing has set up somewhere, by listing id: its own Eat For
 * Less banner, else the one on the shop's own ordering site. Null when
 * neither is set — the caller then takes a photo from the served menu.
 */
export async function shopBanners(prisma: BannerPrisma, listings: BannerListing[]): Promise<Map<string, string | null>> {
  const brandOf = (l: BannerListing) => l.brandId ?? l.location?.brandId ?? null;
  const out = new Map<string, string | null>();
  const missing = listings.filter((l) => {
    out.set(l.id, l.heroImageUrl ?? null);
    return !l.heroImageUrl;
  });
  if (!missing.length) return out;

  const brandIds = [...new Set(missing.map(brandOf).filter((id): id is string => !!id))];
  const locationIds = [...new Set(missing.map((l) => l.locationId))];
  const configs = await prisma.directOrderingConfig.findMany({
    where: { heroImageUrl: { not: null }, OR: [{ brandId: { in: brandIds } }, { locationId: { in: locationIds } }] },
    select: { brandId: true, locationId: true, heroImageUrl: true },
  });
  for (const l of missing) {
    const brand = brandOf(l);
    out.set(
      l.id,
      configs.find((c) => brand && c.brandId === brand)?.heroImageUrl ??
        configs.find((c) => c.locationId === l.locationId)?.heroImageUrl ??
        null,
    );
  }
  return out;
}

type ServedMenu = {
  menu?: {
    bannerImage?: string | null;
    heroImage?: string | null;
    categories?: Array<{ imageUrl?: string | null; items?: Array<{ item?: { imageUrl?: string | null } | null }> }>;
  } | null;
} | null;

/**
 * A picture from the menu the shop actually serves: the menu's banner, else
 * its first category or dish photo. Read from the served menu, never by
 * brand — most shops' dishes sit under one shared parent brand, so a lookup
 * by brand would show another shop's food.
 */
export function servedMenuBanner(store: ServedMenu): string | null {
  const menu = store?.menu;
  if (!menu) return null;
  if (menu.bannerImage) return menu.bannerImage;
  if (menu.heroImage) return menu.heroImage;
  for (const c of menu.categories ?? []) if (c.imageUrl) return c.imageUrl;
  for (const c of menu.categories ?? []) for (const i of c.items ?? []) if (i.item?.imageUrl) return i.item.imageUrl;
  return null;
}
