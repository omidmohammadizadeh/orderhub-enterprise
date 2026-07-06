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
import {
  buildUberEatsMenu,
  toUberServiceAvailability,
} from "./ubereats-menu.transformer";
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

  async publishMenu(args: {
    tenantId: string;
    menuId: string;
    /** Optional overrides from the publish dialog (location → brand picker);
     *  fall back to the menu row's own brand/location. */
    locationId?: string;
    brandId?: string;
  }) {
    const { tenantId, menuId } = args;

    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    const targetBrandId = args.brandId ?? menu.brandId;
    const targetLocationId = args.locationId ?? menu.locationId;
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: targetBrandId,
        tenantId,
        platform: PLATFORM_KEY,
        externalStoreId: { not: null },
        ...(targetLocationId ? { locationId: targetLocationId } : {}),
      },
      select: { id: true, externalStoreId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Uber Eats isn't connected for that brand/location yet. Connect it and pick a store first.",
      );
    }

    const logCtx = {
      tenantId,
      brandId: targetBrandId,
      locationId: targetLocationId,
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
   * Standalone hours push — no dependency on OUR menu records. Uber has no
   * hours endpoint, but we can GET the store's CURRENT live menu, swap its
   * service_availability for the location's opening hours, and PUT it back
   * unchanged otherwise. Falls back to a full republish (when the brand has
   * a menu assigned) only if the store has no live menu yet.
   */
  async pushHoursToStore(uberStoreId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: PLATFORM_KEY, externalStoreId: uberStoreId },
    });
    if (!conn) return { ok: false as const, reason: "store_not_connected" };

    // Location-first hours, brand fallback (same precedence as Deliveroo).
    let openingHours: any = null;
    if (conn.locationId) {
      const loc = await this.prisma.location.findUnique({
        where: { id: conn.locationId },
        select: { openingHours: true },
      });
      const lh: any = loc?.openingHours;
      if (lh && (Array.isArray(lh) ? lh.length > 0 : Object.keys(lh).length > 0)) {
        openingHours = lh;
      }
    }
    if (!openingHours && conn.brandId) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: conn.brandId },
        select: { openingHours: true } as any,
      });
      openingHours = (brand as any)?.openingHours ?? null;
    }
    const availability = toUberServiceAvailability(openingHours);

    // Current live menu straight from Uber.
    const current = await this.client.request<any>(
      "GET",
      `/v2/eats/stores/${encodeURIComponent(uberStoreId)}/menus`,
      { scopes: ["eats.store"] },
    );
    const menus: any[] = current?.menus ?? [];
    // Shape probe: which sections did GET return, and how big? If Uber names
    // a section differently than PUT expects, this is where we see it.
    try {
      const summary = Object.entries(current ?? {})
        .map(([k, v]) => `${k}=${Array.isArray(v) ? (v as any[]).length : typeof v}`)
        .join(" ");
      this.logger.log(`Uber Eats GET menus shape for ${uberStoreId}: ${summary}`);
    } catch {
      /* diagnostics only */
    }
    if (menus.length === 0) {
      // Store has no live menu — hours have nothing to ride on. Try a full
      // republish (works when the brand has a menu assigned on our side).
      const res = await this.republishForStore(uberStoreId);
      if ((res as any)?.ok !== false) return res;
      return { ok: false as const, reason: "no_menu_on_store" };
    }

    const meta: { status?: number } = {};
    // Uber's GET omits empty top-level sections, but their PUT validator
    // requires every field present ("required field modifier_groups not
    // found in data" — live 400). Default the full quartet.
    const body = {
      ...current,
      menus: menus.map((m) => ({ ...m, service_availability: availability })),
      categories: current?.categories ?? [],
      items: current?.items ?? [],
      modifier_groups: current?.modifier_groups ?? [],
    };
    try {
      await this.client.request(
        "PUT",
        `/v2/eats/stores/${encodeURIComponent(uberStoreId)}/menus`,
        { scopes: ["eats.store"], body, meta },
      );
      const days = availability.map(
        (d) => `${d.day_of_week}:${d.time_periods.map((t) => `${t.start_time}-${t.end_time}`).join("|")}`,
      );
      this.logger.log(
        `Uber Eats hours push for store ${uberStoreId}: ${JSON.stringify(days)?.slice(0, 400)} (HTTP ${meta.status})`,
      );
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "UBER_EATS",
        action: "hours.push",
        status: "SUCCESS",
        message: `Opening hours pushed to Uber Eats (live menu updated in place) — Uber responded ${meta.status ?? 204} OK`,
        details: { storeId: uberStoreId, uberHttpStatus: meta.status ?? 204, days },
      });
      return { ok: true as const, uberHttpStatus: meta.status ?? 204, days };
    } catch (err: any) {
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "UBER_EATS",
        action: "hours.push",
        status: "ERROR",
        message: `Opening-hours push to Uber Eats failed: ${err?.message ?? err}`,
        details: { storeId: uberStoreId, uberHttpStatus: meta.status ?? null },
      });
      throw err;
    }
  }

  /**
   * Resolve our internal item ids to the ids that actually exist on Uber's
   * LIVE menu (GET /v2 menus). Matches by exact id first, then external_data
   * (PLU), then case-insensitive title. Returns the resolved Uber ids plus
   * diagnostics so the caller can explain a miss. Never throws.
   */
  async resolveLiveItemIds(
    storeId: string,
    ourIds: string[],
    hint: { plu?: string | null; name?: string | null },
  ): Promise<{
    ids: string[];
    liveCount: number;
    sampleIds: string[];
    matchedBy: string;
  }> {
    let items: any[] = [];
    try {
      const menu = await this.client.request<any>(
        "GET",
        `/v2/eats/stores/${encodeURIComponent(storeId)}/menus?menu_type=MENU_TYPE_FULFILLMENT_DELIVERY`,
        { scopes: ["eats.store"] },
      );
      items = Array.isArray(menu?.items) ? menu.items : [];
      this.logger.log(
        `resolveLiveItemIds: store ${storeId} live menu has ${items.length} items`,
      );
    } catch (err: any) {
      this.logger.warn(
        `resolveLiveItemIds: GET menus failed for ${storeId}: ${err?.message ?? err}`,
      );
      // Can't read — fall back to our ids and let the PATCH try/404.
      return {
        ids: ourIds,
        liveCount: 0,
        sampleIds: [],
        matchedBy: "unverified",
      };
    }
    const byId = new Set<string>();
    const byPlu = new Map<string, string>();
    const byName = new Map<string, string>();
    const enTitle = (t: any): string =>
      (t?.translations && (t.translations.en_us ?? Object.values(t.translations)[0])) ||
      "";
    for (const it of items) {
      if (typeof it?.id === "string") byId.add(it.id);
      const plu = it?.external_data;
      if (typeof plu === "string" && plu) byPlu.set(plu, it.id);
      const nm = enTitle(it?.title).trim().toLowerCase();
      if (nm) byName.set(nm, it.id);
    }
    // 1) exact id matches (our publish path)
    const exact = ourIds.filter((id) => byId.has(id));
    if (exact.length > 0) {
      return {
        ids: exact,
        liveCount: items.length,
        sampleIds: [...byId].slice(0, 8),
        matchedBy: "id",
      };
    }
    // 2) by PLU
    if (hint.plu && byPlu.has(hint.plu)) {
      return {
        ids: [byPlu.get(hint.plu)!],
        liveCount: items.length,
        sampleIds: [...byId].slice(0, 8),
        matchedBy: "plu",
      };
    }
    // 3) by name
    const nameKey = (hint.name ?? "").trim().toLowerCase();
    if (nameKey && byName.has(nameKey)) {
      return {
        ids: [byName.get(nameKey)!],
        liveCount: items.length,
        sampleIds: [...byId].slice(0, 8),
        matchedBy: "name",
      };
    }
    return {
      ids: [],
      liveCount: items.length,
      sampleIds: [...byId].slice(0, 8),
      matchedBy: "none",
    };
  }

  /**
   * Update Menu Item (cert item "Menu: Update Item/modifier") — sparse
   * per-item suspension push, the Uber-correct way to 86 an item:
   *   POST /v2/eats/stores/{store_id}/menus/items/{item_id}
   *   { suspension_info: { suspension: { suspend_until: <epoch s> } } }
   * suspend_until in the future = out of stock until then; suspension null
   * = back on sale (docs: "A null value, or time in the past, indicates
   * that an item is available"). Expects 204; per-item failures (e.g. 404
   * for a size-sku not on the live menu) are tolerated and reported.
   */
  async setItemSuspension(args: {
    storeId: string;
    itemIds: string[];
    suspendUntil: number | null; // epoch seconds; null restores
    reason?: string;
  }): Promise<{
    results: Array<{ itemId: string; httpStatus: number | null; error?: string }>;
  }> {
    const results: Array<{ itemId: string; httpStatus: number | null; error?: string }> = [];
    for (const itemId of args.itemIds) {
      const meta: { status?: number } = {};
      try {
        await this.client.request(
          "POST",
          `/v2/eats/stores/${encodeURIComponent(args.storeId)}/menus/items/${encodeURIComponent(itemId)}`,
          {
            scopes: ["eats.store"],
            meta,
            body: {
              suspension_info: {
                suspension:
                  args.suspendUntil == null
                    ? null
                    : {
                        suspend_until: args.suspendUntil,
                        ...(args.reason ? { reason: args.reason } : {}),
                      },
              },
            },
          },
        );
        results.push({ itemId, httpStatus: meta.status ?? 204 });
      } catch (err: any) {
        results.push({
          itemId,
          httpStatus: meta.status ?? null,
          error: String(err?.message ?? err).slice(0, 160),
        });
      }
    }
    return { results };
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
    // Phase BA — the serving assignment for (location, UBER_EATS, brand)
    // is the source of truth for which menu this store carries; the legacy
    // home-location/brand cascade below covers stores whose menu was never
    // re-published since the assignment migration.
    const assignment = conn.locationId
      ? await (this.prisma as any).menuChannelAssignment.findFirst({
          where: {
            locationId: conn.locationId,
            channel: "UBER_EATS",
            brandId: conn.brandId,
            menu: { deletedAt: null, isActive: true },
          },
          orderBy: { publishedAt: "desc" },
          select: { menu: { select: { id: true, name: true } } },
        })
      : null;
    const menu =
      assignment?.menu ??
      (await this.prisma.menu.findFirst({
        where: {
          brandId: conn.brandId,
          deletedAt: null,
          OR: [{ locationId: conn.locationId }, { locationId: null }],
        },
        orderBy: [{ lastPublishedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
        select: { id: true, name: true },
      }));
    if (!menu) {
      this.logger.warn(
        `Uber Eats menu refresh: no menu found for brand ${conn.brandId}`,
      );
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "UBER_EATS",
        action: "menu.republish",
        status: "WARNING",
        message:
          "Hours/menu push skipped — no menu is assigned to this brand. Create or assign a menu to the brand and publish it to Uber Eats once.",
        details: { storeId: uberStoreId },
      });
      return { ok: false, reason: "no_menu" };
    }
    const res = await this.publishToStore({
      menuId: menu.id,
      menuName: menu.name,
      storeId: uberStoreId,
    });
    this.activity?.record({
      tenantId: conn.tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "MENU",
      channel: "UBER_EATS",
      action: "menu.republish",
      status: "SUCCESS",
      message: `Menu "${menu.name}" republished with current opening hours — Uber responded ${(res as any)?.uberHttpStatus ?? 204} OK`,
      details: {
        storeId: uberStoreId,
        uberHttpStatus: (res as any)?.uberHttpStatus ?? 204,
        serviceAvailabilityDays: (res as any)?.hoursDays ?? undefined,
      },
    });
    return res;
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

    // Store hours ride the menu on Uber (service_availability) — load the
    // menu's location hours, brand as fallback (same precedence as Deliveroo).
    const menuRow = await this.prisma.menu.findUnique({
      where: { id: args.menuId },
      select: {
        locationId: true,
        brandId: true,
        brand: { select: { openingHours: true } },
      },
    });
    let openingHours: any = (menuRow?.brand as any)?.openingHours ?? null;
    const locId =
      menuRow?.locationId ??
      (
        await this.prisma.brandPlatformConnection.findFirst({
          where: {
            brandId: menuRow?.brandId ?? "",
            platform: PLATFORM_KEY,
            externalStoreId: args.storeId,
          },
          select: { locationId: true },
        })
      )?.locationId;
    if (locId) {
      const loc = await this.prisma.location.findUnique({
        where: { id: locId },
        select: { openingHours: true },
      });
      const lh: any = loc?.openingHours;
      const has =
        lh && (Array.isArray(lh) ? lh.length > 0 : Object.keys(lh).length > 0);
      if (has) openingHours = lh;
    }

    const { payload, stats, warnings } = buildUberEatsMenu({
      menuName: args.menuName,
      categories,
      openingHours,
    });
    const hoursDays = payload.menus[0]?.service_availability?.map(
      (d) => `${d.day_of_week}:${d.time_periods.map((t) => `${t.start_time}-${t.end_time}`).join("|")}`,
    );
    this.logger.log(
      `Uber Eats menu ${args.menuId} service_availability: ${JSON.stringify(hoursDays)?.slice(0, 400)}`,
    );
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

    return { ok: true, ...stats, warnings, uberHttpStatus: meta.status, hoursDays };
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
