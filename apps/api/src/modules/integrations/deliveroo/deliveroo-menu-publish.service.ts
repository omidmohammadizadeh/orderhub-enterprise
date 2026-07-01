// Phase BA-5 — Direct Deliveroo menu publish.
//
// Loads an OrderHub menu (categories → products → modifier groups →
// options), transforms it to Deliveroo's Menu API shape, and uploads it via
//   PUT /menu/v1/brands/{brandId}/menus/{menuId}
// which creates-or-updates AND publishes in one call (the v3 S3+job flow is
// only needed for very large menus). The Deliveroo Site ID + Brand ID come
// from the brand's BrandPlatformConnection (Phase BA-2).

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { DeliverooClientService } from "./deliveroo-client.service";
import {
  buildDeliverooMenu,
  type SrcCategory,
  type SrcGroup,
} from "./deliveroo-menu.transformer";

// Item images imported from HubRise are stored as same-origin relative paths
// (/api/v1/menus/hubrise-image/…). Deliveroo fetches image URLs from the
// public internet, so they must be absolutised to our public API origin.
const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

@Injectable()
export class DeliverooMenuPublishService {
  private readonly logger = new Logger(DeliverooMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: DeliverooClientService,
    private readonly config: ConfigService,
  ) {}

  /** Public API origin used to absolutise same-origin image paths. */
  private apiOrigin(): string {
    const raw = this.config.get<string>("app.apiUrl") ?? "";
    // API_URL defaults to localhost in dev/when unset — Deliveroo can't reach
    // that, so fall back to the known production origin (the same one the
    // HubRise callback hard-codes).
    if (!raw || raw.includes("localhost")) return PROD_API_ORIGIN;
    return raw.replace(/\/+$/, "");
  }

  /** Make an image URL absolute + fetchable, or return null if unusable. */
  private absolutiseImage(url?: string | null): string | null {
    const u = (url ?? "").trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("data:")) return null; // Deliveroo can't fetch data URLs
    if (u.startsWith("/")) return `${this.apiOrigin()}${u}`;
    return null;
  }

  async publishMenu(args: { tenantId: string; menuId: string }) {
    const { tenantId, menuId } = args;

    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: {
        id: true,
        name: true,
        brandId: true,
        locationId: true,
        heroImage: true,
        bannerImage: true,
        logoImage: true,
        brand: { select: { logoUrl: true } },
      },
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

    // Cover photo for the mealtime (Deliveroo requires one). Prefer the
    // operator-set menu banner/logo — but those are stored as inline data:
    // URLs Deliveroo can't fetch, so route them through our public cover-image
    // proxy which decodes + streams the bytes. Fall back to the first product
    // image (already an absolute HubRise URL) when no menu-level image exists.
    const proxyCoverUrl = `${this.apiOrigin()}/api/v1/menus/${encodeURIComponent(menuId)}/cover-image`;
    const firstProductImage = categories
      .flatMap((c) => c.products)
      .map((p) => p.imageUrl)
      .find((u) => !!u);
    // Priority: an operator-set banner/hero is the intended cover (served via
    // the proxy since it's usually a data: URL) → else a real food photo from
    // the first product → else a logo (menu or brand) as a last resort.
    const coverImageUrl =
      menu.bannerImage || menu.heroImage
        ? proxyCoverUrl
        : firstProductImage ??
          (menu.logoImage || (menu as any).brand?.logoUrl
            ? proxyCoverUrl
            : null);

    const { payload, stats, warnings } = buildDeliverooMenu({
      menuName: menu.name,
      siteId: conn.externalStoreId!,
      categories,
      coverImageUrl,
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
            imageUrl: this.absolutiseImage(it.imageUrl),
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
