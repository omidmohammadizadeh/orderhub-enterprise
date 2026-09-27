// Retail R3 — what a shop can actually sell online right now.
//
// A restaurant marks things unavailable by hand (the 86 board). A shop counts
// stock, so its storefront follows the count: a product is sold out when every
// counted, active variant of it is at or below zero at this location. A
// product with no counted variant (no barcode yet, or trackStock off) is never
// hidden by this — only by the usual 86.
//
// Plain functions taking a Prisma client, so the ordering module can use them
// without importing the retail module (and its dependencies on orders and
// payments).

import type { PrismaClient } from "@orderhub/database";
import { isRetailType } from "./retail.logic";

type Db = Pick<PrismaClient, "productVariant">;

export function isShop(location: { businessType?: unknown } | null | undefined): boolean {
  return isRetailType((location as any)?.businessType);
}

/** Menu item ids at this location whose counted stock has run out. */
export async function soldOutItemIds(
  prisma: Db,
  locationId: string,
  itemIds: string[],
): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const variants = await prisma.productVariant.findMany({
    where: { menuItemId: { in: itemIds }, isActive: true, trackStock: true },
    select: {
      menuItemId: true,
      stockLevels: { where: { locationId }, select: { quantity: true } },
    },
  });
  const inStock = new Set<string>();
  const counted = new Set<string>();
  for (const v of variants) {
    counted.add(v.menuItemId);
    if ((v.stockLevels[0]?.quantity ?? 0) > 0) inStock.add(v.menuItemId);
  }
  return new Set([...counted].filter((id) => !inStock.has(id)));
}
