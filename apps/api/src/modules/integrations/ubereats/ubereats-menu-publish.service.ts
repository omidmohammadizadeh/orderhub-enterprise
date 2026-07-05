// Phase UE-3 — Direct Uber Eats menu publish.
//
// Loads an OrderHub menu (categories → products → modifier groups → options),
// transforms it to Uber's v2 menu shape, and upserts it via
//   PUT /v2/eats/stores/{store_id}/menus   (scope eats.store, expects 204)
// The Uber store id comes from the brand's UBER_EATS BrandPlatformConnection.
//
// Loading mirrors DeliverooMenuPublishService (multi-SKU products flatten to
// one item per size, size-aware modifier prices) with one addition: per-item
// / per-option / per-SKU UBER_EATS price overrides (platformPricingOverrides
// json + ProductSku.priceOverrides) take precedence over the base price, so
// operators can price-up the marketplace channel to cover Uber's commission.

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { UberEatsClientService } from "./ubereats-client.service";
import { buildUberEatsMenu } from "./ubereats-menu.transformer";
import type {
  SrcCategory,
  SrcGroup,
} from "../deliveroo/deliveroo-menu.transformer";
import {
  extractSizeKey,
  getModifierPrice,
  getModifierPlu,
  isModifierAvailable,
  type ProductSku,
} from "@orderhub/shared";

const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";
const PLATFORM_KEY = "UBER_EATS";

@Injectable()
export class UberEatsMenuPublishService {
  private readonly logger = new Logger(UberEatsMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
    private readonly config: ConfigService,
    // Optional so manually-constructed unit tests keep working.
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private apiOrigin(): string {
    const raw = this.config.get<string>("app.apiUrl") ?? "";
    if (!raw || raw.includes("localhost")) return PROD_API_ORIGIN;
    return raw.replace(/\/+$/, "");
  }

  /** Absolute + publicly fetchable image URL, or null (Uber fetches these). */
  private absolutiseImage(url?: string | null): string | null {
    const u = (url ?? "").trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("data:")) return null;
    if (u.startsWith("/")) return `${this.apiOrigin()}${u}`;
    return null;
  }

  async publishMenu(args: { tenantId: string; menuId: string }) {
    const { tenantId, menuId } = args;

    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: menu.brandId,
        tenantId,
        platform: PLATFORM_KEY,
        externalStoreId: { not: null },
        ...(menu.locationId ? { locationId: menu.locationId } : {}),
      },
      select: { id: true, externalStoreId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Uber Eats isn't connected for this brand yet. Connect it and pick a store first.",
      );
    }

    const logCtx = {
      tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId,
      category: "MENU" as const,
      channel: "UBER_EATS",
      action: "menu.publish",
    };
    try {
      const res = await this.publishToStore({
        menuId,
        menuName: menu.name,
        storeId: conn.externalStoreId!,
      });
      this.activity?.record({
        ...logCtx,
        status: "SUCCESS",
        message: `Menu "${menu.name}" published to Uber Eats store ${conn.externalStoreId} — Uber responded ${(res as any)?.uberHttpStatus ?? 204} OK`,
        details: {
          categories: (res as any)?.categories,
          items: (res as any)?.products,
          warnings: (res as any)?.warnings,
          uberHttpStatus: (res as any)?.uberHttpStatus ?? 204,
        },
      });
      return res;
    } catch (err: any) {
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" publish to Uber Eats failed: ${err?.message ?? err}`,
      });
      throw err;
    }
  }

  /**
   * Webhook-driven republish (store.menu_refresh_request): resolve the
   * connection by Uber store id, pick the brand's most recently published
   * (else most recently updated) menu, and push it.
   */
  async republishForStore(uberStoreId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: PLATFORM_KEY, externalStoreId: uberStoreId },
    });
    if (!conn) {
      this.logger.warn(
        `Uber Eats menu refresh requested for unknown store ${uberStoreId}`,
      );
      return { ok: false, reason: "store_not_connected" };
    }
    const menu = await this.prisma.menu.findFirst({
      where: {
        brandId: conn.brandId,
        deletedAt: null,
        OR: [{ locationId: conn.locationId }, { locationId: null }],
      },
      orderBy: [{ lastPublishedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      select: { id: true, name: true },
    });
    if (!menu) {
      this.logger.warn(
        `Uber Eats menu refresh: no menu found for brand ${conn.brandId}`,
      );
      return { ok: false, reason: "no_menu" };
    }
    return this.publishToStore({
      menuId: menu.id,
      menuName: menu.name,
      storeId: uberStoreId,
    });
  }

  private async publishToStore(args: {
    menuId: string;
    menuName: string;
    storeId: string;
  }) {
    const categories = await this.loadCategories(args.menuId);
    if (categories.length === 0) {
      throw new BadRequestException(
        "This menu has no categories/items to publish.",
      );
    }

    const { payload, stats, warnings } = buildUberEatsMenu({
      menuName: args.menuName,
      categories,
    });
    for (const w of warnings) this.logger.warn(`Uber Eats menu publish: ${w}`);

    this.logger.log(
      `Uber Eats menu publish ${args.menuId} → store ${args.storeId}: ` +
        `${stats.categories} cats / ${stats.products} items / ${stats.groups} groups / ${stats.options} options`,
    );

    const meta: { status?: number } = {};
    await this.client.request(
      "PUT",
      `/v2/eats/stores/${encodeURIComponent(args.storeId)}/menus`,
      { scopes: ["eats.store"], body: payload, meta },
    );

    await this.prisma.menu
      .update({
        where: { id: args.menuId },
        data: { lastPublishedAt: new Date() },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });

    return { ok: true, ...stats, warnings, uberHttpStatus: meta.status };
  }

  // ── Menu loading (mirrors the Deliveroo publish, + UBER_EATS overrides) ──

  private uberPrice(
    overrides: unknown,
    fallback: number,
  ): number {
    const o = overrides as Record<string, unknown> | null | undefined;
    const v = o?.[PLATFORM_KEY];
    return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
  }

  private async loadCategories(menuId: string): Promise<SrcCategory[]> {
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

    const groupsByItem = await this.loadGroupsByItem(Array.from(singleItemIds));
    const groupsById = await this.loadGroupsById(Array.from(skuGroupIds));

    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      products: c.items
        .filter((l) => l.isVisible && l.item)
        .flatMap((l) =>
          this.toSrcProducts(l, skusByItem, groupsByItem, groupsById),
        ),
    }));
  }

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

  private toSrcProducts(
    link: any,
    skusByItem: Map<string, ProductSku[]>,
    groupsByItem: Map<string, SrcGroup[]>,
    groupsById: Map<string, any>,
  ) {
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
              price: this.uberPrice(
                o.platformPricingOverrides,
                getModifierPrice(o, sizeKey),
              ),
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
        // Per-SKU variant override (pricing variants keyed by platform ref).
        const skuPrice = this.uberPrice(
          (sku as any).priceOverrides,
          Number(sku.price) || 0,
        );
        return {
          id: `${it.id}__s${i}`,
          name: `${it.name} - ${sku.name}`,
          description: it.description ?? null,
          price: skuPrice,
          plu: sku.plu || it.plu || it.id,
          taxRate,
          imageUrl,
          available,
          groups,
        };
      });
    }

    const basePrice =
      link.priceOverride != null
        ? Number(link.priceOverride)
        : Number(it.basePrice);
    return [
      {
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        price: this.uberPrice(it.platformPricingOverrides, basePrice),
        plu: it.plu ?? it.sku ?? null,
        taxRate,
        imageUrl,
        available,
        groups: groupsByItem.get(it.id) ?? [],
      },
    ];
  }

  private sizeSlug(key: string): string {
    return String(key).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "x";
  }

  private async loadGroupsById(groupIds: string[]): Promise<Map<string, any>> {
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
          price: this.uberPrice(
            (o as any).platformPricingOverrides,
            Number(o.priceAdjustment),
          ),
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
