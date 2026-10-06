import { matchBuildGuideKey } from "@orderhub/shared";

/**
 * Which brand + name key serves each order line — shared by "How to build"
 * guides and assembly charts. Preference per line: the product's own brand,
 * then the order's brand, then any brand in the tenant (a location's brand is
 * often a placeholder and marketplace lines have no product at all). Within a
 * brand, the product's CURRENT name beats the name frozen on the line.
 */
export async function pickKeysForOrderLines(
  prisma: any,
  order: { brandId: string | null; items: Array<{ menuItemId: string | null; name: string }> },
  keys: Array<{ brandId: string; nameKey: string }>,
): Promise<Array<{ brandId: string | null; nameKey: string } | null>> {
  if (keys.length === 0) return order.items.map(() => null);

  const menuItemIds = order.items.map((l) => l.menuItemId).filter(Boolean) as string[];
  const products = menuItemIds.length
    ? await prisma.menuItem.findMany({
        where: { id: { in: menuItemIds } },
        select: { id: true, brandId: true, name: true },
      })
    : [];
  const productById = new Map<string, { brandId: string; name: string }>(products.map((p: any) => [p.id, p]));

  const keysByBrand = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  for (const k of keys) {
    allKeys.add(k.nameKey);
    if (!keysByBrand.has(k.brandId)) keysByBrand.set(k.brandId, new Set());
    keysByBrand.get(k.brandId)!.add(k.nameKey);
  }

  return order.items.map((l) => {
    const product = l.menuItemId ? productById.get(l.menuItemId) : undefined;
    const names = [product?.name, l.name].filter(Boolean) as string[];
    const brands = [product?.brandId, order.brandId].filter(Boolean) as string[];
    for (const brandId of brands) {
      for (const n of names) {
        const k = matchBuildGuideKey(n, keysByBrand.get(brandId) ?? []);
        if (k) return { brandId, nameKey: k };
      }
    }
    for (const n of names) {
      const k = matchBuildGuideKey(n, allKeys);
      if (k) return { brandId: null, nameKey: k };
    }
    return null;
  });
}
