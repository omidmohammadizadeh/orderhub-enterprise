// Phase BA-5 — Direct Deliveroo menu publish.
//
// Loads an OrderHub menu (categories → products → modifier groups →
// options), transforms it to Deliveroo's Menu API shape, and uploads it via
//   PUT /menu/v1/brands/{brandId}/menus/{menuId}
// which creates-or-updates AND publishes in one call (the v3 S3+job flow is
// only needed for very large menus). The Deliveroo Site ID + Brand ID come
// from the brand's BrandPlatformConnection (Phase BA-2).

import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { DeliverooClientService } from "./deliveroo-client.service";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../../menus/variant-price-resolver.service";
import {
  buildDeliverooMenu,
  type SrcCategory,
  type SrcGroup,
  type SrcProduct,
} from "./deliveroo-menu.transformer";
import {
  extractSizeKey,
  getModifierPrice,
  getModifierPlu,
  isModifierAvailable,
  type ProductSku,
} from "@orderhub/shared";

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
    private readonly variantResolver: VariantPriceResolverService,
    @Optional() private readonly activity?: ActivityLogService,
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

  async publishMenu(args: {
    tenantId: string;
    menuId: string;
    /** Phase BA — publish for THIS location's Deliveroo store (multi-
     *  location menus publish once per selected location). Falls back to
     *  the menu's home location, then any brand connection. */
    locationId?: string;
  }) {
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

    // Resolve the brand's connected Deliveroo store. Prefer the explicit
    // target location (Phase BA), then the menu's own home location; fall
    // back to any connected Deliveroo store for the brand.
    const targetLocationId = args.locationId ?? menu.locationId;
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: menu.brandId,
        tenantId,
        platform: "DELIVEROO",
        externalStoreId: { not: null },
        externalBrandId: { not: null },
        ...(targetLocationId ? { locationId: targetLocationId } : {}),
      },
      select: { externalStoreId: true, externalBrandId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Deliveroo isn't connected for this brand yet. Connect it under Locations → Brands → Deliveroo first.",
      );
    }

    // Phase BF — variant-menu publish. Only set when the brand's Channels
    // settings name a source menu for DELIVEROO; null otherwise, in which
    // case every price falls back to normal (base price / category
    // priceOverride) exactly as before.
    const variantMap = await this.variantResolver.forBrandChannel({
      brandId: menu.brandId,
      channel: "DELIVEROO",
    });
    const categories = await this.loadCategories(menuId, variantMap);
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
    const logCtx = {
      tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId,
      category: "MENU" as const,
      channel: "DELIVEROO",
      action: "menu.publish",
    };
    try {
      await this.client.request(
        "PUT",
        `/menu/v1/brands/${conn.externalBrandId}/menus/${encodeURIComponent(menuId)}`,
        payload,
      );
      this.activity?.record({
        ...logCtx,
        status: "SUCCESS",
        message: `Menu "${menu.name}" published to Deliveroo site ${conn.externalStoreId}`,
        details: { categories: stats.categories, items: stats.products, warnings },
      });
    } catch (e: any) {
      // Deliveroo rate-limits menu upload to 1 request per minute per site.
      const msg = String(e?.message ?? "");
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" publish to Deliveroo failed: ${msg}`,
      });
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
   *
   * Multi-SKU products (a pizza with sizes, each size carrying its own price,
   * PLU and modifier groups) are FLATTENED to one Deliveroo item per size —
   * Deliveroo has no native size concept, so "Margherita - 12 inch" ships as
   * its own item at the 12-inch price with the 12-inch modifier groups (each
   * option priced from the size-aware pricesBySize map).
   */
  private async loadCategories(
    menuId: string,
    variantMap: VariantPriceMap | null,
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

    // Split items into single-price vs multi-SKU, and collect the modifier
    // groups each needs so we can batch-load. Single-price items link groups
    // via ModifierGroupOnItem; multi-SKU items name their groups by id in
    // each SKU's `modifierGroups`.
    const singleItemIds = new Set<string>();
    const skuGroupIds = new Set<string>();
    const skusByItem = new Map<string, ProductSku[]>();
    for (const c of cats) {
      for (const link of c.items) {
        const it = link.item;
        if (!link.isVisible || !it) continue;
        const skus = this.readSkus(it);
        if (skus.length > 0) {
          skusByItem.set(it.id, skus);
          for (const s of skus)
            for (const gid of s.modifierGroups ?? []) skuGroupIds.add(gid);
        } else {
          singleItemIds.add(it.id);
        }
      }
    }

    const groupsByItem = await this.loadGroupsByItem(
      Array.from(singleItemIds),
      variantMap,
    );
    const groupsById = await this.loadGroupsById(Array.from(skuGroupIds));

    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      products: c.items
        .filter((l) => l.isVisible && l.item)
        .flatMap((l) =>
          this.toSrcProducts(l, skusByItem, groupsByItem, groupsById, variantMap),
        ),
    }));
  }

  /** Parse the productSkus JSON into typed rows (only for multi-SKU items). */
  private readSkus(it: any): ProductSku[] {
    if (!it?.hasMultipleSkus) return [];
    const raw = Array.isArray(it.productSkus) ? it.productSkus : [];
    return raw
      .filter((s: any) => s && typeof s.name === "string")
      .map((s: any) => ({
        name: String(s.name),
        plu: s.plu ? String(s.plu) : "",
        price: Number(s.price) || 0,
        modifierGroups: Array.isArray(s.modifierGroups)
          ? s.modifierGroups.map(String)
          : [],
        priceOverrides: s.priceOverrides ?? undefined,
      }));
  }

  /** One menu item → one Deliveroo product, or N (one per SKU) if multi-SKU. */
  private toSrcProducts(
    link: any,
    skusByItem: Map<string, ProductSku[]>,
    groupsByItem: Map<string, SrcGroup[]>,
    groupsById: Map<string, any>,
    variantMap: VariantPriceMap | null,
  ): SrcProduct[] {
    const it = link.item;
    const taxRate = Number(it.deliveryTax);
    const imageUrl = this.absolutiseImage(it.imageUrl);
    const available = it.isAvailable !== false;
    const skus = skusByItem.get(it.id);

    if (skus && skus.length > 0) {
      return skus.map((sku, i) => {
        const sizeKey = extractSizeKey(sku.name) ?? sku.name;
        const groups: SrcGroup[] = [];
        for (const gid of sku.modifierGroups ?? []) {
          const g = groupsById.get(gid);
          if (!g) continue;
          const options = (g.options ?? [])
            .filter((o: any) =>
              isModifierAvailable(o, sizeKey, { audience: "customer" }),
            )
            .map((o: any) => ({
              id: `${o.id}__${this.sizeSlug(sizeKey)}`,
              name: o.name,
              price: variantMap?.optionPrice(o) ?? getModifierPrice(o, sizeKey),
              plu: getModifierPlu(o, sizeKey) ?? o.id,
              taxRate: Number(o.deliveryTax),
              available: o.isAvailable !== false,
            }));
          if (options.length === 0) continue;
          groups.push({
            id: `${g.id}__${this.sizeSlug(sizeKey)}`,
            name: g.name,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            selectionType: g.selectionType,
            allowDuplicateSelections: g.allowDuplicateSelections,
            options,
          });
        }
        return {
          id: `${it.id}__s${i}`,
          name: `${it.name} - ${sku.name}`,
          description: it.description ?? null,
          price: variantMap?.skuPrice(it, sku) ?? (Number(sku.price) || 0),
          plu: sku.plu || it.plu || it.id,
          taxRate,
          imageUrl,
          available,
          groups,
        };
      });
    }

    // Single-price item.
    const price =
      variantMap?.itemPrice(it) ??
      (link.priceOverride != null
        ? Number(link.priceOverride)
        : Number(it.basePrice));
    return [
      {
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        price,
        plu: it.plu ?? it.sku ?? null,
        taxRate,
        imageUrl,
        available,
        groups: groupsByItem.get(it.id) ?? [],
      },
    ];
  }

  /** Deliveroo ids must be simple tokens — slugify a size key for suffixes. */
  private sizeSlug(key: string): string {
    return String(key).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "x";
  }

  /** Load modifier groups (with options) by id — for multi-SKU SKU groups. */
  private async loadGroupsById(
    groupIds: string[],
  ): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (groupIds.length === 0) return out;
    const groups = await this.prisma.modifierGroup.findMany({
      where: { id: { in: groupIds } },
      include: {
        options: {
          where: { isAvailable: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    for (const g of groups) out.set(g.id, g);
    return out;
  }

  private async loadGroupsByItem(
    itemIds: string[],
    variantMap: VariantPriceMap | null,
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
          price: variantMap?.optionPrice(o) ?? Number(o.priceAdjustment),
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
