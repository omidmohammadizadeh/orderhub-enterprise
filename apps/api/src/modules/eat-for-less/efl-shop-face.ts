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
  menuItem: { findMany: (args: any) => Promise<Array<{ brandId: string; imageUrl: string | null }>> };
};

/**
 * The picture across the top of each listing's card, by listing id.
 *
 * Few shops upload a banner for Eat For Less, and a card that falls back to
 * a drawing reads as "not a real shop". So: the listing's own banner, else
 * the banner on the shop's own ordering site, else a photo from its menu.
 * Null only when the shop has no photo anywhere.
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
  const site = (l: BannerListing) => {
    const brand = brandOf(l);
    return (
      configs.find((c) => brand && c.brandId === brand)?.heroImageUrl ??
      configs.find((c) => c.locationId === l.locationId)?.heroImageUrl ??
      null
    );
  };

  const needPhoto = [...new Set(missing.filter((l) => !site(l)).map(brandOf).filter((id): id is string => !!id))];
  const photos = needPhoto.length
    ? await prisma.menuItem.findMany({
        where: { brandId: { in: needPhoto }, isAvailable: true, imageUrl: { not: null } },
        orderBy: { sortOrder: "asc" },
        distinct: ["brandId"],
        select: { brandId: true, imageUrl: true },
      })
    : [];
  for (const l of missing) {
    const brand = brandOf(l);
    out.set(l.id, site(l) ?? photos.find((p) => p.brandId === brand)?.imageUrl ?? null);
  }
  return out;
}
