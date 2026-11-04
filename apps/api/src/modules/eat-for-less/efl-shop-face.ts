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
