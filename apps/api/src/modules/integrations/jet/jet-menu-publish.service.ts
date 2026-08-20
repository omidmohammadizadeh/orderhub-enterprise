import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";
import {
  buildJetMenus,
  toJetAvailability,
  allDayAvailability,
  type JetMenuType,
  type JetSrcCategory,
  type JetSrcGroup,
  type JetSrcProduct,
} from "./jet-menu.transformer";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../../menus/variant-price-resolver.service";
import {
  getModifierPlu,
  getModifierPrice,
  isModifierAvailable,
  extractSizeKey,
  type ProductSku,
} from "@orderhub/shared";
import { sizeBasePrice } from "../shared/publish-sizes";

// Phase JE-3 — direct Just Eat (JET Connect) menu publish.
//
// Loads an OrderHub menu (categories → products → modifier groups → options),
// transforms it to JET's ingest shape and POSTs it to /menus. The restaurant
// references come from the brand's BrandPlatformConnection.
//
// ⚠️ THE 202 MEANS NOTHING. The spec is explicit: "currently, our platform
// only checks if the menu structure is valid. However, a valid menu may still
// fail to publish on the corresponding delivery partner platform." The real
// outcome arrives asynchronously on `callback_url` as
// {restaurant, ingestion_succeeded, error}. So we always send a callback URL
// and treat the callback — not this call — as the answer. That is also the
// only way the 97% menu-injection target is measurable at all.
//
// NOT TOUCHED, deliberately: transformMenuToCatalog and the HubRise
// auto-master composer. JET gets its own transformer; the shared pieces reused
// here are the read-only size/modifier helpers that Deliveroo and Uber already
// share (@orderhub/shared, integrations/shared/publish-sizes).

const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

@Injectable()
export class JetMenuPublishService {
  private readonly logger = new Logger(JetMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    private readonly config: ConfigService,
    private readonly variantResolver: VariantPriceResolverService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private apiOrigin(): string {
    const raw = this.config.get<string>("app.apiUrl") ?? "";
    // JET's servers fetch our image URLs, so localhost is useless to them.
    if (!raw || raw.includes("localhost")) return PROD_API_ORIGIN;
    return raw.replace(/\/+$/, "");
  }

  /** Absolute, publicly fetchable, or null. */
  private absolutiseImage(url?: string | null): string | null {
    const u = (url ?? "").trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    // JET cannot fetch a data: URL, and publishing one produces a broken
    // image on a live customer page rather than no image.
    if (u.startsWith("data:")) return null;
    if (u.startsWith("/")) return `${this.apiOrigin()}${u}`;
    return null;
  }

  /** Where JET posts the real (asynchronous) ingest result. */
  private callbackUrl(): string {
    return `${this.apiOrigin()}/api/v1/integrations/jet/menu-callback`;
  }

  async publishMenu(args: {
    tenantId: string;
    menuId: string;
    /** Publish for THIS location's JET restaurant. Falls back to the menu's. */
    locationId?: string;
    /** Defaults to both DELIVERY and COLLECTION. */
    serviceTypes?: JetMenuType[];
  }) {
    const { tenantId, menuId } = args;

    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        brandId: true,
        locationId: true,
      },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    const targetLocationId = args.locationId ?? menu.locationId;
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: menu.brandId,
        tenantId,
        platform: "JUST_EAT",
        status: { not: "not_connected" },
        ...(targetLocationId ? { locationId: targetLocationId } : {}),
      },
      select: {
        id: true,
        locationId: true,
        externalStoreId: true,
        metadata: true,
      },
    });
    if (!conn) {
      throw new BadRequestException(
        "Just Eat isn't connected for this brand yet. Connect it under Locations → Brands → Just Eat first.",
      );
    }

    // JET's menu endpoints key on the restaurant reference THEY issued, which
    // is not necessarily the POS location id orders arrive stamped with.
    const metadata = (conn.metadata ?? {}) as Record<string, any>;
    const restaurantReference =
      (metadata.restaurantReference ?? "").trim?.() || conn.externalStoreId;
    if (!restaurantReference) {
      throw new BadRequestException(
        "This Just Eat connection has no restaurant reference. Add it under the brand's Just Eat settings — " +
          "menus are published against JET's own restaurant id, not the POS location id.",
      );
    }

    // Phase BF — only set when the brand's Channels settings name a source
    // menu for JUST_EAT; null otherwise, in which case every price falls back
    // to the base price exactly as before.
    const variantMap = await this.variantResolver.forBrandChannel({
      brandId: menu.brandId,
      channel: "JUST_EAT",
    });

    const categories = await this.loadCategories(menuId, variantMap);
    if (categories.length === 0) {
      throw new BadRequestException("This menu has no categories/items to publish.");
    }

    const availability = await this.resolveAvailability(
      conn.locationId,
      menu.brandId,
    );

    const { menus, stats, warnings } = buildJetMenus({
      menuName: menu.name,
      menuReference: menu.id,
      description: menu.description ?? null,
      categories,
      availability,
      serviceTypes: args.serviceTypes,
    });
    for (const w of warnings) this.logger.warn(`JET menu publish: ${w}`);

    const payload = {
      restaurants: [restaurantReference],
      menus,
      callback_url: this.callbackUrl(),
    };

    this.logger.log(
      `JET menu publish ${menuId} → restaurant ${restaurantReference}: ` +
        `${stats.menus} menus (${menus.map((m: any) => m.type).join("+")}) / ` +
        `${stats.categories} cats / ${stats.items} items / ${stats.portions} portions / ` +
        `${stats.groups} groups / ${stats.options} options`,
    );

    const logCtx = {
      tenantId,
      brandId: menu.brandId,
      locationId: conn.locationId,
      category: "MENU" as const,
      channel: "JUST_EAT",
      action: "menu.publish",
    };

    try {
      await this.client.request("POST", "/menus", {
        keyType: "menu",
        brandId: menu.brandId,
        locationId: conn.locationId,
        country: metadata.country ?? null,
        body: payload,
        // Menu publishes are operator-initiated and idempotent (the menu
        // reference is stable), so a transient 5xx is worth riding out rather
        // than making someone click again.
        retries: 2,
      });
    } catch (e: any) {
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" publish to Just Eat failed: ${String(e?.message ?? e)}`,
      });
      throw e;
    }

    // Deliberately NOT recorded as SUCCESS. A 202 means "structurally valid";
    // the delivery partner can still reject it, and the menu-callback handler
    // is what upgrades this to a real outcome.
    this.activity?.record({
      ...logCtx,
      status: "INFO",
      message:
        `Menu "${menu.name}" sent to Just Eat for restaurant ${restaurantReference} — ` +
        `awaiting their ingest result`,
      details: { ...stats, restaurantReference, warnings },
    });

    // Record what we are expecting a callback for, so a callback that never
    // arrives is visible rather than merely absent.
    await this.markAwaitingCallback(conn.id, {
      menuId,
      restaurantReference,
      sentAt: new Date().toISOString(),
    });

    await this.prisma.menu
      .update({ where: { id: menuId }, data: { lastPublishedAt: new Date() } })
      .catch(() => {
        /* best-effort bookkeeping */
      });

    return {
      ok: true,
      pending: true,
      restaurant: restaurantReference,
      ...stats,
      warnings,
    };
  }

  /**
   * Handle JET's asynchronous ingest callback.
   *
   * `{ restaurant, ingestion_succeeded, error?: { code, message } }`, one call
   * per restaurant. THIS is the menu-publish outcome — the 202 was only ever
   * "the JSON parsed".
   */
  async handleMenuCallback(payload: any): Promise<{ handled: boolean; reason?: string }> {
    const restaurant = String(payload?.restaurant ?? "").trim();
    const succeeded = payload?.ingestion_succeeded === true;
    const error = payload?.error ?? null;

    if (!restaurant) return { handled: false, reason: "no_restaurant" };

    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "JUST_EAT",
        OR: [
          { metadata: { path: ["restaurantReference"], equals: restaurant } },
          { externalStoreId: restaurant },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        metadata: true,
      },
    });
    if (!conn) {
      this.logger.warn(
        `JET menu callback for unknown restaurant ${restaurant} — ignoring`,
      );
      return { handled: false, reason: "restaurant_not_connected" };
    }

    const metadata = { ...((conn.metadata as any) ?? {}) };
    const awaiting = metadata.jetMenuPublish ?? {};
    metadata.jetMenuPublish = {
      ...awaiting,
      lastResultAt: new Date().toISOString(),
      lastResultSucceeded: succeeded,
      lastErrorCode: error?.code ?? null,
      lastErrorMessage: error?.message ?? null,
    };
    await this.prisma.brandPlatformConnection
      .update({ where: { id: conn.id }, data: { metadata: metadata as any } })
      .catch(() => {
        /* best-effort bookkeeping */
      });

    if (succeeded) {
      this.logger.log(`JET menu ingest SUCCEEDED for restaurant ${restaurant}`);
    } else {
      this.logger.error(
        `JET menu ingest FAILED for restaurant ${restaurant}: ` +
          `${error?.code ?? "no code"} — ${error?.message ?? "no message"}`,
      );
    }

    this.activity?.record({
      tenantId: conn.tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "MENU",
      channel: "JUST_EAT",
      action: "menu.publish_result",
      status: succeeded ? "SUCCESS" : "ERROR",
      message: succeeded
        ? `Just Eat accepted the menu for restaurant ${restaurant}`
        : `Just Eat rejected the menu for restaurant ${restaurant}: ` +
          `${error?.message ?? error?.code ?? "no reason given"}`,
      details: { restaurant, menuId: awaiting.menuId ?? null, error },
    });

    return { handled: true };
  }

  // ── Menu graph → transformer source ──────────────────────────────────

  /**
   * Opening hours for the menu's availability, location first then brand.
   *
   * In the UK, IE, ES, IT and AU the menu availability ALSO sets the
   * restaurant's opening hours, so sending a wrong-but-plausible default here
   * would quietly change when the shop appears open. Falling back to all-day
   * is the safe direction: the service-times endpoint (JE-5) then narrows it,
   * whereas a too-narrow menu availability cannot be widened by anything.
   */
  private async resolveAvailability(locationId: string, brandId: string) {
    const [location, brand] = await Promise.all([
      this.prisma.location.findUnique({
        where: { id: locationId },
        select: { openingHours: true },
      }),
      this.prisma.brand.findUnique({
        where: { id: brandId },
        select: { openingHours: true },
      }),
    ]);
    for (const raw of [location?.openingHours, brand?.openingHours]) {
      if (!raw) continue;
      const availability = toJetAvailability(raw);
      if (Object.values(availability).some((slots) => slots.length > 0)) {
        return availability;
      }
    }
    this.logger.warn(
      `JET publish: no opening hours on location ${locationId} or brand ${brandId} — ` +
        `publishing all-day availability`,
    );
    return allDayAvailability();
  }

  private async loadCategories(
    menuId: string,
    variantMap: VariantPriceMap | null,
  ): Promise<JetSrcCategory[]> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId, isVisible: true },
      orderBy: { sortOrder: "asc" },
      include: {
        items: { orderBy: { sortOrder: "asc" }, include: { item: true } },
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
          for (const s of skus) {
            for (const gid of s.modifierGroups ?? []) skuGroupIds.add(gid);
          }
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

    // Count why items were dropped instead of leaving the operator to guess.
    // JET's own rejection for an empty menu says nothing about which filter
    // emptied it.
    const dropped = { hidden: 0, missing: 0, variant: 0 };
    const result = cats.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      products: c.items
        .filter((l) => {
          if (!l.isVisible) return (dropped.hidden++, false);
          if (!l.item) return (dropped.missing++, false);
          if (!(variantMap?.appliesToItem(l.item) ?? true)) {
            return (dropped.variant++, false);
          }
          return true;
        })
        .map((l) =>
          this.toSrcProduct(l, skusByItem, groupsByItem, groupsById, variantMap),
        ),
    }));

    const links = cats.reduce((n, c) => n + c.items.length, 0);
    const kept = result.reduce((n, c) => n + c.products.length, 0);
    this.logger.log(
      `JET publish menu=${menuId}: ${cats.length} categories, ${links} item links → ` +
        `kept ${kept} (dropped hidden=${dropped.hidden} missing=${dropped.missing} ` +
        `variant-brand=${dropped.variant}); ${skusByItem.size} sized products → portions`,
    );

    if (links > 0 && kept === 0) {
      const restrictedTo = variantMap?.restrictedBrandId ?? null;
      throw new BadRequestException(
        dropped.variant > 0
          ? `All ${links} items were excluded by the pricing variant configured for JUST_EAT ` +
            `(it restricts this publish to brand ${restrictedTo}). Either clear the source ` +
            `menu/variant under Channels → Just Eat, point the variant at this menu's brand, ` +
            `or add that brand to these items.`
          : `This menu's ${links} item links are all hidden or point at deleted products, ` +
            `so there is nothing to publish.`,
      );
    }
    return result;
  }

  /** Parse the productSkus JSON into typed rows (multi-SKU items only). */
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

  /**
   * One menu item → one JET item.
   *
   * Always ONE, never several: a multi-SKU product becomes a single item with
   * `portions`, so the customer sees "Margherita" with a size selector rather
   * than three separate products, and each size carries its own price, PLU and
   * modifier groups natively.
   */
  private toSrcProduct(
    link: any,
    skusByItem: Map<string, ProductSku[]>,
    groupsByItem: Map<string, JetSrcGroup[]>,
    groupsById: Map<string, any>,
    variantMap: VariantPriceMap | null,
  ): JetSrcProduct {
    const it = link.item;
    const imageUrl = this.absolutiseImage(it.imageUrl);
    const skus = skusByItem.get(it.id);

    if (skus && skus.length > 0) {
      const portions = skus.map((sku, i) => {
        const sizeKey = extractSizeKey(sku.name) ?? sku.name;
        const groups: JetSrcGroup[] = [];
        for (const gid of sku.modifierGroups ?? []) {
          const g = groupsById.get(gid);
          if (!g) continue;
          const options = (g.options ?? [])
            .filter((o: any) =>
              isModifierAvailable(o, sizeKey, { audience: "customer" }),
            )
            .map((o: any) => ({
              id: o.id,
              name: o.name,
              description: o.description ?? null,
              price: variantMap?.optionPrice(o) ?? getModifierPrice(o, sizeKey),
              plu: getModifierPlu(o, sizeKey) ?? o.id,
            }));
          if (options.length === 0) continue;
          groups.push(this.toSrcGroup(g, options));
        }
        return {
          // Matches the reference the 86 push sends for a size, so an
          // availability update lands on the thing that was published.
          id: `${it.id}__s${i}`,
          name: sku.name,
          description: it.description ?? null,
          price: variantMap?.skuPrice(it, sku) ?? (Number(sku.price) || 0),
          plu: sku.plu || `${it.id}__s${i}`,
          groups,
        };
      });

      return {
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        price: sizeBasePrice(skus),
        plu: it.plu || it.id,
        imageUrl,
        groups: [],
        portions,
      };
    }

    const price =
      variantMap?.itemPrice(it) ??
      (link.priceOverride != null
        ? Number(link.priceOverride)
        : Number(it.basePrice));
    return {
      id: it.id,
      name: it.name,
      description: it.description ?? null,
      price,
      plu: it.plu ?? it.sku ?? null,
      imageUrl,
      groups: groupsByItem.get(it.id) ?? [],
    };
  }

  private toSrcGroup(g: any, options: JetSrcGroup["options"]): JetSrcGroup {
    return {
      id: g.id,
      name: g.name,
      description: g.description ?? null,
      minSelection: Number(g.minSelections ?? 0),
      maxSelection: Number(g.maxSelections ?? 0),
      repeatable: !!g.allowDuplicateSelections,
      options,
    };
  }

  private async loadGroupsById(groupIds: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (groupIds.length === 0) return out;
    const groups = await this.prisma.modifierGroup.findMany({
      where: { id: { in: groupIds } },
      include: {
        options: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } },
      },
    });
    for (const g of groups) out.set(g.id, g);
    return out;
  }

  private async loadGroupsByItem(
    itemIds: string[],
    variantMap: VariantPriceMap | null,
  ): Promise<Map<string, JetSrcGroup[]>> {
    const out = new Map<string, JetSrcGroup[]>();
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
      const options = (g.options ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        description: o.description ?? null,
        price: variantMap?.optionPrice(o) ?? Number(o.priceAdjustment),
        plu: o.plu ?? null,
      }));
      const arr = out.get(link.itemId) ?? [];
      arr.push(this.toSrcGroup(g, options));
      out.set(link.itemId, arr);
    }
    return out;
  }

  private async markAwaitingCallback(
    connectionId: string,
    info: Record<string, unknown>,
  ): Promise<void> {
    try {
      const conn = await this.prisma.brandPlatformConnection.findUnique({
        where: { id: connectionId },
        select: { metadata: true },
      });
      const metadata = { ...((conn?.metadata as any) ?? {}) };
      metadata.jetMenuPublish = {
        ...(metadata.jetMenuPublish ?? {}),
        ...info,
        lastResultAt: null,
        lastResultSucceeded: null,
      };
      await this.prisma.brandPlatformConnection.update({
        where: { id: connectionId },
        data: { metadata: metadata as any, lastSyncAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`JET publish bookkeeping failed: ${e?.message}`);
    }
  }
}
