// Multi-buy deals for the till.
//
// The POS prices multi-buys itself (the till is trusted, like its promo
// codes), with the same @orderhub/shared engine the storefront and checkout
// use. This hands it the deals live on the POS channel, re-anchored onto the
// items the till's menu actually serves.

import { Injectable, NotFoundException } from "@nestjs/common";
import type { MultiBuyDeal } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";
import { MarketingService } from "../marketing/marketing.service";
import { anchorIds, indexServedMenu } from "../marketing/promo-anchor";

@Injectable()
export class RetailDealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly marketing: MarketingService,
  ) {}

  async tillDeals(tenantId: string, locationId: string): Promise<{ multiBuys: MultiBuyDeal[] }> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: { id: true, brandId: true, timezone: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    const menu: any = await this.menus.findActiveMenuForLocation(locationId, tenantId);
    // Every brand trading here: the till sells whatever its menu holds, and a
    // deal only ever touches item ids that menu serves.
    const brands = await this.prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true },
    });
    const brandIds = [...new Set([menu?.brandId, location.brandId, ...brands.map((b) => b.id)].filter(Boolean))];
    // A cashier doesn't know who the shopper is, so only "everyone" deals.
    const deals = await this.marketing.resolveMultiBuys(brandIds, "POS", ["ALL"], location.timezone ?? undefined);
    if (!deals.length) return { multiBuys: [] };

    const served = indexServedMenu(menu);
    const referenced = [...new Set(deals.flatMap((d) => [...d.itemIds, ...d.slots.flatMap((s) => s.itemIds)]))];
    const stale = referenced.filter((id) => !served.servedIds.has(id));
    const rows = stale.length
      ? await this.prisma.menuItem.findMany({
          where: { id: { in: stale } },
          select: { id: true, name: true, externalId: true },
        })
      : [];
    const map = anchorIds(served, referenced, rows);
    const remap = (ids: string[]) => [...new Set(ids.map((id) => map.get(id)).filter((x): x is string => !!x))];
    return {
      multiBuys: deals
        .map((d) => ({
          ...d,
          itemIds: remap(d.itemIds),
          slots: d.slots.map((s) => ({ ...s, itemIds: remap(s.itemIds) })),
        }))
        .filter((d) => (d.mode === "MEAL_DEAL" ? d.slots.every((s) => s.itemIds.length) : d.itemIds.length)),
    };
  }
}
