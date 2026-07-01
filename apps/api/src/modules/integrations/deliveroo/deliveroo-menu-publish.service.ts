// Phase BA-5 — Direct Deliveroo menu publish.
//
// Loads an OrderHub menu (categories → products → modifier groups →
// options), transforms it to Deliveroo's Menu API shape, and uploads it via
//   PUT /menu/v1/brands/{brandId}/menus/{menuId}
// which creates-or-updates AND publishes in one call (the v3 S3+job flow is
// only needed for very large menus). The Deliveroo Site ID + Brand ID come
// from the brand's BrandPlatformConnection (Phase BA-2).

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { DeliverooClientService } from "./deliveroo-client.service";
import {
  buildDeliverooMenu,
  type SrcCategory,
  type SrcGroup,
} from "./deliveroo-menu.transformer";

@Injectable()
export class DeliverooMenuPublishService {
  private readonly logger = new Logger(DeliverooMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: DeliverooClientService,
  ) {}

  async publishMenu(args: { tenantId: string; menuId: string }) {
    const { tenantId, menuId } = args;

    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    // Resolve the brand's connected Deliveroo store. Prefer the menu's own
    // location; fall back to any connected Deliveroo store for the brand.
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: menu.brandId,
        tenantId,
        platform: "DELIVEROO",
        externalStoreId: { not: null },
        externalBrandId: { not: null },
        ...(menu.locationId ? { locationId: menu.locationId } : {}),
      },
      select: { externalStoreId: true, externalBrandId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Deliveroo isn't connected for this brand yet. Connect it under Locations → Brands → Deliveroo first.",
      );
    }

    const categories = await this.loadCategories(menuId, menu.brandId);
    if (categories.length === 0) {
      throw new BadRequestException(
        "This menu has no categories/items to publish.",
      );
    }

    const { payload, stats, warnings } = buildDeliverooMenu({
      menuName: menu.name,
      siteId: conn.externalStoreId!,
      categories,
    });
    for (const w of warnings) this.logger.warn(`Deliveroo menu publish: ${w}`);

    this.logger.log(
      `Deliveroo menu publish ${menuId} → brand ${conn.externalBrandId} site ${conn.externalStoreId}: ` +
        `${stats.categories} cats / ${stats.products} items / ${stats.groups} groups / ${stats.options} options`,
    );

    // PUT create-or-update-and-publish. Deliveroo menu id = our menu id
    // (stable, so a re-publish updates the same menu instead of duplicating).
    try {
      await this.client.request(
        "PUT",
        `/menu/v1/brands/${conn.externalBrandId}/menus/${encodeURIComponent(menuId)}`,
        payload,
      );
    } catch (e: any) {
      // Deliveroo rate-limits menu upload to 1 request per minute per site.
      const msg = String(e?.message ?? "");
      if (msg.includes("429") || msg.includes("too_many_requests")) {
        throw new BadRequestException(
          "Deliveroo only allows one menu publish per minute per site. Wait a minute and try again.",
        );
      }
      throw e;
    }

    // Stamp the outbound publish so the Menu Manager shows it landed.
    await this.prisma.menu
      .update({
        where: { id: menuId },
        data: { lastPublishedAt: new Date() },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });

    return { ok: true, ...stats, warnings };
  }

  /**
   * Load the menu's categories with their products, each product's modifier
   * groups, and each group's options — flattened into the transformer's
   * source shape. Prices come out in pounds (Prisma Decimal → Number).
   */
  private async loadCategories(
    menuId: string,
    brandId: string,
  ): Promise<SrcCategory[]> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId, isVisible: true },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
          orderBy: { sortOrder: "asc" },
          include: { item: true },
        },
      },
    });

    // Collect the visible products, keeping their category grouping.
    const allItemIds = new Set<string>();
    for (const c of cats) {
      for (const link of c.items) {
        if (link.isVisible && link.item) {
          allItemIds.add(link.item.id);
        }
      }
    }

    // One query for every product's modifier groups + options.
    const groupsByItem = await this.loadGroupsByItem(Array.from(allItemIds));

    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      products: c.items
        .filter((l) => l.isVisible && l.item)
        .map((l) => {
          const it = l.item;
          const price =
            l.priceOverride != null
              ? Number(l.priceOverride)
              : Number(it.basePrice);
          return {
            id: it.id,
            name: it.name,
            description: it.description ?? null,
            price,
            plu: it.plu ?? it.sku ?? null,
            taxRate: Number(it.deliveryTax),
            imageUrl: it.imageUrl ?? null,
            available: it.isAvailable !== false,
            groups: groupsByItem.get(it.id) ?? [],
          };
        }),
    }));
  }

  private async loadGroupsByItem(
    itemIds: string[],
  ): Promise<Map<string, SrcGroup[]>> {
    const out = new Map<string, SrcGroup[]>();
    if (itemIds.length === 0) return out;

    const links = await this.prisma.modifierGroupOnItem.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: { sortOrder: "asc" },
      include: {
        group: {
          include: {
            options: {
              where: { isAvailable: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
      },
    });

    for (const link of links) {
      const g = link.group;
      if (!g) continue;
      const src: SrcGroup = {
        id: g.id,
        name: g.name,
        minSelections: g.minSelections,
        maxSelections: g.maxSelections,
        selectionType: g.selectionType,
        allowDuplicateSelections: g.allowDuplicateSelections,
        options: (g.options ?? []).map((o) => ({
          id: o.id,
          name: o.name,
          price: Number(o.priceAdjustment),
          plu: o.plu ?? null,
          taxRate: Number(o.deliveryTax),
          available: o.isAvailable !== false,
        })),
      };
      const arr = out.get(link.itemId) ?? [];
      arr.push(src);
      out.set(link.itemId, arr);
    }
    return out;
  }
}
