import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  currencyForCountry,
  extractSizeKey,
  getModifierPrice,
  isModifierAvailable,
  type ProductSku,
} from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../../menus/variant-price-resolver.service";
import { CareemApiError, CareemClientService } from "./careem-client.service";
import {
  transformCareemMenu,
  type CareemMenuProblem,
  type CareemPriceUnit,
  type SourceGroup,
  type SourceMenu,
} from "./careem-menu.transformer";

// Phase CA-3 — push a menu to Careem.
//
// The push is ASYNCHRONOUS. PUT /catalogs returns a request_id immediately and
// the outcome arrives minutes later, either by polling
// GET /catalogs/status/{request_id} or on the CATALOG_REQUEST_STATUS_UPDATED
// webhook. A 200 here means "accepted for processing", not "live" — about five
// minutes to appear on the SuperApp, per their docs. Treating the 200 as
// success is the same mistake JET's /menus 202 invites.
//
// Rate limits are theirs and tight: one sync per branch every two minutes, 50
// a minute across all branches. The two-minute one is enforced here, because
// hitting it returns a 409 that reads like a conflict rather than a throttle.

/** Careem's per-branch floor between syncs. */
const MIN_SYNC_INTERVAL_MS = 2 * 60_000;

/** Careem's FAQ gives UAE and KSA. Jordan is theirs to confirm. */
/** Careem's own ceiling, separate from the two-minute per-branch floor. */
const MAX_SYNCS_PER_MINUTE = 50;

const VAT_BY_COUNTRY: Record<string, number> = { AE: 5, SA: 15, JO: 16 };

@Injectable()
export class CareemMenuPublishService {
  private readonly logger = new Logger(CareemMenuPublishService.name);
  /** Last push per branch, to honour their two-minute floor. */
  private readonly lastSync = new Map<string, number>();
  /** Push timestamps across EVERY branch, for their second, separate cap. */
  private readonly recentSyncs: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
    @Optional() private readonly variantResolver?: VariantPriceResolverService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Which unit Careem wants prices in.
   *
   * Unresolved: their schema says `integer` and never says of what. Their
   * example shows `"price": 20`, which reads as whole dirhams, but an integer
   * in whole dirhams cannot express 11.50 — which a real menu is full of. The
   * transformer refuses to round, so a wrong setting here fails loudly with
   * the offending items named rather than silently mispricing a menu by 100×.
   */
  private get priceUnit(): CareemPriceUnit {
    return process.env.CAREEM_PRICE_UNIT === "minor" ? "minor" : "major";
  }

  /**
   * Publish a location's menu to its Careem branch.
   *
   * Returns the request id to track, or the reasons we refused to send.
   */
  async publish(
    locationId: string,
    tenantId?: string,
  ): Promise<
    { ok: true; requestId: string } | { ok: false; errors: CareemMenuProblem[] }
  > {
    this.assertWithinRateLimits(locationId);

    const menu = await this.loadMenu(locationId, tenantId);
    const { payload, errors } = transformCareemMenu(menu, {
      unit: this.priceUnit,
      branchId: locationId,
    });

    if (!payload) {
      // Refused before the round trip. Careem's own validation would reject
      // most of this five minutes later with a message that names neither the
      // entity nor the id.
      this.logger.warn(
        `Careem publish for ${locationId} refused with ${errors.length} problem(s)`,
      );
      return { ok: false, errors };
    }

    const brandId = await this.brandIdFor(locationId, tenantId);
    const res = await this.client.request<{ request_id?: string }>("/catalogs", {
      method: "PUT",
      branchId: locationId,
      ...(brandId ? { brandId } : {}),
      body: payload,
    });
    this.lastSync.set(locationId, Date.now());
    this.recentSyncs.push(Date.now());

    const requestId = String(res?.request_id ?? "");
    this.logger.log(
      `Careem catalog accepted for ${locationId} as request ${requestId} — ` +
        `NOT live yet, ~5 minutes to appear on the SuperApp`,
    );
    return { ok: true, requestId };
  }

  /**
   * Publish a menu to a brand's Careem branch at a location.
   *
   * What the Publish menu pop-up and Auto publish call. The menu is the one the
   * operator chose, and the branch comes from the connection, so several brands
   * at one kitchen each publish to their own branch.
   */
  async publishMenu(args: {
    tenantId: string;
    menuId: string;
    locationId?: string;
    brandId?: string;
  }) {
    const menu = await this.prisma.menu.findFirst({
      where: {
        id: args.menuId,
        brand: { tenantId: args.tenantId },
        deletedAt: null,
      },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");

    const brandId = args.brandId ?? menu.brandId;
    const locationId = args.locationId ?? menu.locationId ?? undefined;
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId: args.tenantId,
        platform: "CAREEM",
        brandId,
        ...(locationId ? { locationId } : {}),
        externalStoreId: { not: null },
        status: { not: "not_connected" },
      },
    });
    if (conns.length === 0) {
      throw new BadRequestException(
        "Careem isn't connected for this brand at this location yet. Connect it under Locations → Brands → Careem first.",
      );
    }
    if (conns.length > 1) {
      throw new BadRequestException(
        "This brand is on Careem at more than one location. Pick the location to publish to.",
      );
    }
    return this.publishToConnection(args.tenantId, conns[0]!, menu);
  }

  /** The Publish button on the brand page: uses whichever menu serves Careem. */
  async publishAssigned(tenantId: string, connectionId: string) {
    const conn = await this.connection(tenantId, connectionId);
    return this.publishToConnection(
      tenantId,
      conn,
      await this.menuForConnection(conn),
    );
  }

  /** The catalog a publish would send for this connection. Sends nothing. */
  async previewConnection(
    tenantId: string,
    connectionId: string,
    menuId?: string,
  ) {
    const conn = await this.connection(tenantId, connectionId);
    const menu = menuId
      ? await this.prisma.menu.findFirst({
          where: { id: menuId, brand: { tenantId }, deletedAt: null },
          select: { id: true, name: true },
        })
      : await this.menuForConnection(conn);
    if (!menu) throw new NotFoundException("Menu not found");
    const { payload, errors } = await this.buildForConnection(
      tenantId,
      conn,
      menu,
    );
    return {
      sourceMenu: { id: menu.id, name: menu.name },
      wouldPublish: !!payload,
      problems: errors,
      counts: {
        categories: payload?.categories.length ?? 0,
        items: payload?.items.length ?? 0,
        groups: payload?.groups.length ?? 0,
        options: payload?.options.length ?? 0,
      },
      payload,
    };
  }

  /**
   * Careem's verdict on a catalog push, from their webhook.
   *
   * A stale verdict (an older request finishing after a newer push) is ignored,
   * so the brand page always reports the catalog that is actually current.
   */
  async recordCatalogStatus(details: Record<string, unknown>): Promise<void> {
    const branchId = String(details?.vendor_branch_id ?? details?.catalog_id ?? "");
    if (!branchId) return;
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "CAREEM", externalStoreId: branchId },
    });
    if (!conn) return; // The location-only branch from the Careem page.

    const meta = (conn.metadata ?? {}) as Record<string, any>;
    const current = meta.careemCatalog ?? {};
    if (
      current.requestId &&
      String(current.requestId) !== String(details.request_id ?? "")
    ) {
      return;
    }
    const status = String(details.status ?? "");
    await this.saveCatalog(conn.id, meta, {
      ...current,
      status,
      finishedAt: new Date().toISOString(),
    });
    if (status && status !== "COMPLETED") {
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "CAREEM",
        action: "menu.publish",
        status: "ERROR",
        message: `Careem did not complete the menu publish (status ${status}).`,
        details,
      });
    }
  }

  private async publishToConnection(
    tenantId: string,
    conn: CareemConnectionRow,
    menu: { id: string; name: string },
  ) {
    const branchId = conn.externalStoreId;
    if (!branchId) {
      throw new BadRequestException("This Careem connection has no branch yet.");
    }
    this.assertWithinRateLimits(branchId);

    const log = {
      tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "MENU" as const,
      channel: "CAREEM",
      action: "menu.publish",
    };
    const meta = (conn.metadata ?? {}) as Record<string, any>;
    const { payload, errors } = await this.buildForConnection(
      tenantId,
      conn,
      menu,
    );
    if (!payload) {
      this.activity?.record({
        ...log,
        status: "ERROR",
        message: `Menu "${menu.name}" was not sent to Careem: ${errors.length} problem(s) to fix first.`,
        details: { errors: errors.slice(0, 30) },
      });
      return { ok: false as const, errors };
    }

    const stats = {
      categories: payload.categories.length,
      items: payload.items.length,
      groups: payload.groups.length,
      options: payload.options.length,
    };
    let res: { request_id?: string };
    try {
      res = await this.client.request<{ request_id?: string }>("/catalogs", {
        method: "PUT",
        branchId,
        brandId: conn.brandId,
        body: payload,
      });
    } catch (err) {
      const message =
        err instanceof CareemApiError ? err.message : (err as Error).message;
      await this.saveCatalog(conn.id, meta, {
        ...(meta.careemCatalog ?? {}),
        menuId: menu.id,
        menuName: menu.name,
        status: "SEND_FAILED",
        message,
        sentAt: new Date().toISOString(),
      });
      this.activity?.record({
        ...log,
        status: "ERROR",
        message: `Menu "${menu.name}" upload to Careem failed: ${message}`,
      });
      throw err;
    }

    this.lastSync.set(branchId, Date.now());
    this.recentSyncs.push(Date.now());
    const requestId = String(res?.request_id ?? "");
    await this.saveCatalog(conn.id, meta, {
      menuId: menu.id,
      menuName: menu.name,
      requestId,
      status: "PROCESSING",
      sentAt: new Date().toISOString(),
      finishedAt: null,
      stats,
      // What 86 pushes check against, so an item from another brand at the same
      // kitchen is never sent to this branch.
      itemIds: (payload.items as Array<{ id: string }>).map((i) => i.id),
    });
    this.activity?.record({
      ...log,
      status: "SUCCESS",
      message: `Menu "${menu.name}" sent to Careem (${stats.items} items). About 5 minutes to appear on the SuperApp.`,
    });
    this.logger.log(
      `Careem catalog accepted for branch ${branchId} as request ${requestId}`,
    );
    return { ok: true as const, requestId, stats };
  }

  private async buildForConnection(
    tenantId: string,
    conn: CareemConnectionRow,
    menu: { id: string; name: string },
  ) {
    const location = await this.prisma.location.findFirst({
      where: { id: conn.locationId, deletedAt: null, brand: { tenantId } },
      select: { country: true },
    });
    if (!location) throw new BadRequestException("Location not found");
    const variantMap =
      (await this.variantResolver?.forBrandChannel({
        brandId: conn.brandId,
        channel: "CAREEM",
      })) ?? null;
    const source = await this.buildSource(
      tenantId,
      menu,
      { locationId: conn.locationId, country: location.country },
      variantMap,
    );
    return transformCareemMenu(source, {
      unit: this.priceUnit,
      branchId: conn.externalStoreId ?? conn.id,
    });
  }

  /** The menu assigned to Careem here, else the brand's newest active one. */
  private async menuForConnection(conn: CareemConnectionRow) {
    const assigned = await (this.prisma as any).menuChannelAssignment
      .findFirst({
        where: {
          channel: "CAREEM",
          brandId: conn.brandId,
          locationId: conn.locationId,
        },
        select: { menuId: true },
      })
      .catch(() => null);
    const menu = await this.prisma.menu.findFirst({
      where: assigned?.menuId
        ? { id: assigned.menuId, deletedAt: null }
        : { brandId: conn.brandId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!menu) {
      throw new BadRequestException(
        "This brand has no active menu yet. Build or import one, then publish it to Careem.",
      );
    }
    return menu;
  }

  private async connection(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "CAREEM" },
    });
    if (!conn) throw new NotFoundException("Careem connection not found");
    return conn;
  }

  private async saveCatalog(
    connectionId: string,
    meta: Record<string, any>,
    careemCatalog: Record<string, unknown>,
  ) {
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: {
        lastSyncAt: new Date(),
        metadata: { ...meta, careemCatalog } as never,
      },
    });
  }

  /** Their two limits, checked before anything is sent. */
  private assertWithinRateLimits(branchId: string): void {
    const since = Date.now() - (this.lastSync.get(branchId) ?? 0);
    if (since < MIN_SYNC_INTERVAL_MS) {
      throw new BadRequestException(
        `Careem allows one catalog sync per branch every 2 minutes. Try again in ` +
          `${Math.ceil((MIN_SYNC_INTERVAL_MS - since) / 1000)}s.`,
      );
    }
    // The per-branch floor does not cover this one: 50 syncs a minute across
    // all branches. A chain republishing every shop at once is how it gets hit,
    // and a 429 costs the whole batch rather than the one over the line.
    const minuteAgo = Date.now() - 60_000;
    while (this.recentSyncs.length && this.recentSyncs[0]! < minuteAgo) {
      this.recentSyncs.shift();
    }
    if (this.recentSyncs.length >= MAX_SYNCS_PER_MINUTE) {
      throw new BadRequestException(
        `Careem allow ${MAX_SYNCS_PER_MINUTE} catalog syncs a minute across all ` +
          `branches. Try again shortly.`,
      );
    }
  }

  /**
   * Build the catalog without sending it.
   *
   * The transformer makes every decision that can go wrong — the price unit,
   * their group min/max rules, which items are publishable at all — and all of
   * them are cheaper to read here than to discover from a rejection five
   * minutes after an upload.
   */
  async dryRun(locationId: string, tenantId?: string) {
    const menu = await this.loadMenu(locationId, tenantId);
    const { payload, errors } = transformCareemMenu(menu, {
      unit: this.priceUnit,
      branchId: locationId,
    });
    return {
      // Which of the brand's menus this is: the newest-edited ACTIVE one, so
      // a forgotten older active menu silently wins over the one just built.
      sourceMenu: { id: menu.id, name: menu.name },
      wouldPublish: !!payload,
      problems: errors,
      counts: {
        categories: payload?.categories.length ?? 0,
        items: payload?.items.length ?? 0,
        groups: payload?.groups.length ?? 0,
        options: payload?.options.length ?? 0,
      },
      payload,
    };
  }

  /**
   * Careem RETIRED this on 24 April 2024.
   *
   * Kept, and kept behind a flag, because their own FAQ says a partner "may
   * request an approval for consuming the endpoint" — so it is disabled
   * rather than gone. Without that approval it answers API_DEPRECATED_ERROR.
   *
   * The replacement is the ordinary publish: our push is always diff:false, a
   * full replace, and Careem delete whatever the payload omits. That already
   * does what a reset was for.
   */
  async resetCatalog(locationId: string, tenantId?: string) {
    if (process.env.CAREEM_ALLOW_CATALOG_RESET !== "true") {
      throw new BadRequestException(
        "Careem deprecated DELETE /catalogs on 24 April 2024 and it returns " +
          "API_DEPRECATED_ERROR. Publish the menu instead — our push is a full " +
          "replace, so it clears anything Careem still hold. If Careem have " +
          "approved this endpoint for us, set CAREEM_ALLOW_CATALOG_RESET=true.",
      );
    }
    if (tenantId) await this.assertOwned(locationId, tenantId);
    const brandId = await this.brandIdFor(locationId, tenantId);
    await this.client.request("/catalogs", {
      method: "DELETE",
      branchId: locationId,
      ...(brandId ? { brandId } : {}),
    });
    return {
      ok: true,
      note:
        "Nothing is gone yet. Careem only drop the old catalog when the next " +
        "full push arrives — publish the menu to complete the reset.",
    };
  }

  /** Poll one catalog request. The webhook says the same thing unprompted;
   *  this exists for when it hasn't arrived and someone is watching. */
  async status(locationId: string, requestId: string, tenantId?: string) {
    if (tenantId) await this.assertOwned(locationId, tenantId);
    return this.client.request(`/catalogs/status/${encodeURIComponent(requestId)}`, {
      method: "GET",
      branchId: locationId,
    });
  }

  /**
   * Snooze or restore items — Careem's 86 endpoint.
   *
   * Capped at 40 per call by them, so callers with more must chunk; doing it
   * silently here would hide that a bulk change was split and partly failed.
   */
  async setItemAvailability(
    locationId: string,
    catalogId: string,
    items: Array<{ id: string; active: boolean }>,
  ): Promise<void> {
    if (items.length > 40) {
      throw new BadRequestException(
        `Careem accepts at most 40 items per availability call (got ${items.length}).`,
      );
    }
    await this.client.request(
      `/catalogs/${encodeURIComponent(catalogId)}/items`,
      {
        method: "PATCH",
        branchId: locationId,
        body: {
          items: items.map((i) => ({
            id: i.id,
            status: i.active ? "active" : "inactive",
          })),
        },
      },
    );
  }

  private async brandIdFor(
    locationId: string,
    tenantId?: string,
  ): Promise<string | null> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, ...(tenantId ? { brand: { tenantId } } : {}) },
      select: { brandId: true },
    });
    return loc?.brandId ?? null;
  }

  /** Locations carry no tenantId of their own — they hang off the brand.
   *  Anything reachable from a browser has to check this. */
  private async assertOwned(locationId: string, tenantId: string) {
    const owned = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!owned) throw new BadRequestException("Location not found");
  }

  /**
   * Assemble the menu in the shape the transformer wants.
   *
   * Only what Careem can express: visible categories, available items, and the
   * modifier groups those items actually reference. Publishing a hidden item
   * would put it on the SuperApp where nobody here expects to see it.
   */
  private async loadMenu(
    locationId: string,
    tenantId?: string,
  ): Promise<SourceMenu> {
    const location = await this.prisma.location.findFirst({
      where: {
        id: locationId,
        deletedAt: null,
        ...(tenantId ? { brand: { tenantId } } : {}),
      },
      select: { id: true, name: true, brandId: true, country: true },
    });
    if (!location) throw new BadRequestException("Location not found");

    const menu = await this.prisma.menu.findFirst({
      where: { brandId: location.brandId, isActive: true },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!menu) throw new BadRequestException("No active menu for this brand");

    const tenant = await this.prisma.brand.findUnique({
      where: { id: location.brandId },
      select: { tenantId: true },
    });
    return this.buildSource(
      tenantId ?? tenant?.tenantId ?? "",
      menu,
      { locationId: location.id, country: location.country },
      null,
    );
  }

  /**
   * Read a menu into the transformer's shape.
   *
   * Sized products are the part Careem have no concept of. They become a
   * required "Size" group whose options carry the price difference from the
   * cheapest size, and each size's own modifier groups hang off its option,
   * which Careem nest natively. A group whose prices change by size is published
   * once per size, with the ids suffixed; CareemOrderService strips the suffixes
   * again to name the order lines.
   */
  private async buildSource(
    tenantId: string,
    menu: { id: string; name: string },
    place: { locationId: string; country: string },
    variantMap: VariantPriceMap | null,
  ): Promise<SourceMenu> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { menuId: menu.id, isVisible: true },
      orderBy: { sortOrder: "asc" },
      include: {
        items: { orderBy: { sortOrder: "asc" }, include: { item: true } },
      },
    });

    const rows = new Map<string, any>();
    for (const category of categories) {
      for (const link of category.items as any[]) {
        const item = link.item;
        if (
          !item ||
          link.isVisible === false ||
          item.visibleToCustomers === false ||
          !(variantMap?.appliesToItem(item) ?? true) ||
          rows.has(item.id)
        ) {
          continue;
        }
        rows.set(item.id, {
          ...item,
          _priceOverride: link.priceOverride,
          _sortOrder: link.sortOrder ?? 0,
        });
      }
    }
    const snoozed = await this.snoozedItemIds(
      [...rows.keys()],
      place.locationId,
    );

    const skusByItem = new Map<string, ProductSku[]>();
    const singleIds: string[] = [];
    const direct = new Set<string>();
    for (const item of rows.values()) {
      const skus = readSkus(item);
      if (skus.length) {
        skusByItem.set(item.id, skus);
        for (const sku of skus) {
          for (const g of sku.modifierGroups ?? []) direct.add(g);
        }
      } else {
        singleIds.push(item.id);
      }
    }
    const links = singleIds.length
      ? await this.prisma.modifierGroupOnItem.findMany({
          where: { itemId: { in: singleIds } },
          select: { itemId: true, groupId: true },
          orderBy: { sortOrder: "asc" },
        })
      : [];
    const groupIdsByItem = new Map<string, string[]>();
    for (const l of links) {
      groupIdsByItem.set(l.itemId, [
        ...(groupIdsByItem.get(l.itemId) ?? []),
        l.groupId,
      ]);
      direct.add(l.groupId);
    }
    const groupRows = await this.loadGroupsDeep(tenantId, [...direct]);

    const groups = new Map<string, SourceGroup>();
    const optionPrice = (option: any, sizeKey: string | null) =>
      sizeKey
        ? getModifierPrice(option, sizeKey)
        : (variantMap?.optionPrice(option) ?? getModifierPrice(option, null));
    const shape = (group: any, sizeKey: string | null) =>
      (group.options ?? [])
        .filter((o: any) =>
          isModifierAvailable({ ...o, isAvailable: true }, sizeKey, {
            audience: "customer",
          }),
        )
        .map((o: any) => `${o.id}:${optionPrice(o, sizeKey)}`)
        .join("|");
    const groupCode = (groupId: string, sizeKey: string | null): string | null => {
      const group = groupRows.get(groupId);
      if (!group) return null;
      const sized = sizeKey != null && shape(group, sizeKey) !== shape(group, null);
      const suffix = sized ? `__${slug(sizeKey)}` : "";
      const code = `${groupId}${suffix}`;
      if (groups.has(code)) return code;

      const entry: SourceGroup = {
        id: code,
        name: group.name,
        secondLanguageName: group.secondLanguageName,
        description: group.description,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        isRequired: group.isRequired,
        sortOrder: group.sortOrder,
        selectionType: group.selectionType === "ADDON" ? "ADDON" : "VARIANT",
        options: [],
      };
      // Registered before its options are walked, so a cycle terminates.
      groups.set(code, entry);
      entry.options = (group.options ?? [])
        .filter((o: any) =>
          isModifierAvailable(
            { ...o, isAvailable: true },
            sized ? sizeKey : null,
            { audience: "customer" },
          ),
        )
        .map((o: any) => {
          // The legacy array is still populated on older rows, so both are read.
          const nested = [
            ...new Set<string>([
              ...((o.modifierGroupIds ?? []) as string[]),
              ...((o.nestedGroupLinks ?? []) as any[]).map((l) => l.groupId),
            ]),
          ]
            .map((id) => groupCode(id, null))
            .filter((c): c is string => !!c);
          return {
            id: `${o.id}${suffix}`,
            name: o.name,
            secondLanguageName: o.secondLanguageName,
            priceAdjustment: optionPrice(o, sized ? sizeKey : null),
            // Out of stock publishes inactive, so a later sync can restore it.
            isAvailable: o.isAvailable !== false,
            sortOrder: o.sortOrder,
            ...(nested.length ? { groupIds: nested } : {}),
          };
        });
      return code;
    };

    const items: SourceMenu["items"] = [];
    for (const item of rows.values()) {
      const common = {
        id: item.id,
        name: item.name,
        secondLanguageName: item.secondLanguageName,
        description: item.description,
        // 86'd items publish as inactive rather than vanishing, so the SuperApp
        // shows them greyed out and the next sync can restore them.
        isAvailable:
          item.isAvailable !== false &&
          item.outOfStock !== true &&
          !snoozed.has(item.id),
        imageUrl: mediaUrl(item.imageUrl),
        calories: item.calories,
        allergens: item.allergens ?? [],
        sortOrder: item._sortOrder,
      };
      const skus = skusByItem.get(item.id);
      if (skus?.length) {
        const prices = skus.map(
          (s) => variantMap?.skuPrice(item, s) ?? (Number(s.price) || 0),
        );
        const cheapest = Math.min(...prices);
        const sizeGroupId = `${item.id}__size`;
        groups.set(sizeGroupId, {
          id: sizeGroupId,
          name: "Size",
          secondLanguageName: "الحجم",
          minSelections: 1,
          maxSelections: 1,
          isRequired: true,
          sortOrder: 0,
          selectionType: "VARIANT",
          options: skus.map((sku, i) => {
            const sizeKey = extractSizeKey(sku.name) ?? sku.name;
            const nested = (sku.modifierGroups ?? [])
              .map((g) => groupCode(g, sizeKey))
              .filter((c): c is string => !!c);
            return {
              id: `${item.id}__size${i}`,
              name: sku.name,
              priceAdjustment: prices[i]! - cheapest,
              isAvailable: true,
              sortOrder: i,
              ...(nested.length ? { groupIds: nested } : {}),
            };
          }),
        });
        items.push({ ...common, basePrice: cheapest, groupIds: [sizeGroupId] });
      } else {
        items.push({
          ...common,
          basePrice:
            variantMap?.itemPrice(item) ??
            (item._priceOverride != null
              ? Number(item._priceOverride)
              : Number(item.basePrice)),
          groupIds: (groupIdsByItem.get(item.id) ?? [])
            .map((g) => groupCode(g, null))
            .filter((c): c is string => !!c),
        });
      }
    }

    return {
      id: menu.id,
      name: menu.name,
      country: place.country,
      // Careem want their own integer for the currency; the transformer maps
      // it and refuses a currency they have no id for.
      currency: currencyForCountry(place.country),
      // Careem prices INCLUDE tax — this is the rate baked into them, not one
      // to add. Their FAQ states UAE 5% and KSA 15%. Jordan is the third
      // country they serve and they never gave a figure for it; 16% is its
      // standard sales tax. Wrong here misreports the split, not the price.
      taxPercentage: VAT_BY_COUNTRY[place.country] ?? 5,
      categories: categories
        .map((category: any) => ({
          id: category.id,
          name: category.name,
          secondLanguageName: category.secondLanguageName,
          description: category.description,
          sortOrder: category.sortOrder,
          itemIds: [
            ...new Set<string>(
              category.items
                .filter((l: any) => l.item && rows.has(l.item.id))
                .map((l: any) => l.item.id as string),
            ),
          ],
        }))
        // Careem have no use for an empty category, and one with only hidden
        // items would otherwise show as a blank heading.
        .filter((c) => c.itemIds.length > 0),
      items,
      groups: [...groups.values()],
    };
  }

  /** The groups those items use and any nested under their options. Resolved by
   *  id and tenant: a shared group need not belong to the selling brand. */
  private async loadGroupsDeep(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    let frontier = [...new Set(ids)];
    while (frontier.length) {
      const rows = await this.prisma.modifierGroup.findMany({
        where: { id: { in: frontier }, brand: { tenantId } },
        include: {
          options: {
            orderBy: { sortOrder: "asc" },
            // Nested groups live in the join table since Phase BN.
            include: { nestedGroupLinks: { select: { groupId: true } } },
          },
        },
      });
      const next: string[] = [];
      for (const group of rows as any[]) {
        if (out.has(group.id)) continue;
        out.set(group.id, group);
        for (const option of group.options) {
          next.push(
            ...((option.modifierGroupIds ?? []) as string[]),
            ...option.nestedGroupLinks.map((l: any) => l.groupId as string),
          );
        }
      }
      frontier = [...new Set(next)].filter((id) => !out.has(id));
    }
    return out;
  }

  /** Items 86'd on Careem, or everywhere, at this location right now. */
  private async snoozedItemIds(
    itemIds: string[],
    locationId: string,
  ): Promise<Set<string>> {
    if (!itemIds.length) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability
      ?.findMany({
        where: {
          channel: { in: ["CAREEM", "ALL"] },
          itemId: { in: itemIds },
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: [{ locationId: null }, { locationId }] },
          ],
        },
        select: { itemId: true },
      })
      .catch(() => []);
    return new Set((rows ?? []).map((r: any) => String(r.itemId)));
  }
}

type CareemConnectionRow = {
  id: string;
  brandId: string;
  locationId: string;
  externalStoreId: string | null;
  metadata: unknown;
};

function readSkus(item: any): ProductSku[] {
  if (!item?.hasMultipleSkus) return [];
  const raw = Array.isArray(item.productSkus) ? item.productSkus : [];
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Careem fetch photos themselves: https only, relative paths made absolute. */
function mediaUrl(url?: string | null): string | null {
  const u = String(url ?? "").trim();
  if (/^https:\/\//i.test(u)) return u;
  const origin = (process.env.API_URL ?? "").replace(/\/+$/, "");
  return u.startsWith("/") && origin.startsWith("https://") ? `${origin}${u}` : null;
}
