// Phase AW-14 — Menu Availability ("86 board") service.
//
// Per-item, per-channel snooze. One row per (itemId, channel) pair
// flipped off. The row's existence + a future-or-null expires_at is
// the single source of truth. Storefront / POS / marketplace filters
// call getSnoozedItemIdsForChannel() at read time — no cron needed.

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { HubRiseCatalogService } from "../integrations/hubrise/hubrise-catalog.service";
import { DeliverooClientService } from "../integrations/deliveroo/deliveroo-client.service";
import { UberEatsMenuPublishService } from "../integrations/ubereats/ubereats-menu-publish.service";
import { ActivityLogService } from "../logs/activity-log.service";

// Mirrors the publish-menu modal's TARGETS. Free-form string in the DB
// so adding (e.g.) CAREEM later doesn't need a migration.
export type SupportedChannel =
  | "ONLINE"
  | "POS"
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "WHATSAPP"
  | "HUBRISE";

// Operator presets from the spec. Translated to an `expiresAt` Date
// in resolveExpiry().
export type DurationPreset =
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "12h"
  | "until_tomorrow"
  | "indefinite";

@Injectable()
export class MenuAvailabilityService {
  private readonly logger = new Logger(MenuAvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => HubRiseCatalogService))
    private readonly hubrise: HubRiseCatalogService,
    private readonly deliverooClient: DeliverooClientService,
    private readonly uberEatsMenu: UberEatsMenuPublishService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────

  /**
   * Inventory board payload — every item for the brand + its current
   * snooze state per channel. Expired snoozes are filtered out.
   */
  async getBrandMatrix(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    // Scope to the brand's MOST RECENTLY PUBLISHED menu: the 86 board should
    // mirror what customers actually see on the live menu (whichever channel
    // it was last published to — Deliveroo / HubRise / storefront), not every
    // product ever tagged to the brand. The publish flow stamps Menu.brandId +
    // lastPublishedAt, so "latest published menu for this brand" is a direct
    // lookup. We take that menu's items via its categories.
    //
    // Fallback: a brand with no published menu yet keeps the old behaviour —
    // items tagged to the brand (primary brandId or shared via brandIds) — so
    // the board isn't empty before the first publish.
    const lastPublished = await this.prisma.menu.findFirst({
      where: { brandId, deletedAt: null, lastPublishedAt: { not: null } },
      orderBy: { lastPublishedAt: "desc" },
      select: { id: true, name: true },
    });

    let itemIds: string[];
    if (lastPublished) {
      const cats = await this.prisma.menuCategory.findMany({
        where: { menuId: lastPublished.id, isVisible: true },
        select: {
          items: {
            where: { isVisible: true },
            select: { itemId: true },
          },
        },
      });
      itemIds = Array.from(
        new Set(cats.flatMap((c) => c.items.map((l) => l.itemId))),
      );
    } else {
      const tagged = await this.prisma.menuItem.findMany({
        where: { OR: [{ brandId }, { brandIds: { has: brandId } }] },
        select: { id: true },
      });
      itemIds = tagged.map((r) => r.id);
    }
    if (itemIds.length === 0) return { items: [] };

    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        name: true,
        plu: true,
        imageUrl: true,
        basePrice: true,
        hasMultipleSkus: true,
        productSkus: true,
        isAvailable: true,
      },
      orderBy: { name: "asc" },
    });
    if (items.length === 0) return { items: [] };

    const now = new Date();
    const snoozes = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        itemId: { in: items.map((i) => i.id) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const byItem = new Map<string, Record<string, any>>();
    for (const s of snoozes) {
      if (!byItem.has(s.itemId)) byItem.set(s.itemId, {});
      byItem.get(s.itemId)![s.channel] = {
        expiresAt: s.expiresAt,
        snoozeReason: s.snoozeReason,
        snoozedAt: s.snoozedAt,
        snoozedBy: s.snoozedBy,
      };
    }

    return {
      // Which menu these items came from, so the board can show
      // "Showing: <last published menu>" (null when falling back to
      // brand-tagged items before the first publish).
      sourceMenu: lastPublished
        ? { id: lastPublished.id, name: lastPublished.name }
        : null,
      items: items.map((it) => ({
        ...it,
        snoozes: byItem.get(it.id) ?? {},
      })),
    };
  }

  /**
   * Read-time filter used by storefront + POS + marketplace listing.
   * Returns the set of itemIds currently snoozed for the given
   * channel. Caller does `items.filter(i => !snoozed.has(i.id))`.
   */
  async getSnoozedItemIdsForChannel(
    channel: SupportedChannel,
    candidateItemIds: string[],
  ): Promise<Set<string>> {
    if (candidateItemIds.length === 0) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        channel,
        itemId: { in: candidateItemIds },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { itemId: true },
    });
    return new Set(rows.map((r: { itemId: string }) => r.itemId));
  }

  // ─── Writes ────────────────────────────────────────────────────────

  /**
   * Snooze (a.k.a. 86) an item for one channel.
   *
   *   - `duration`: preset code ("1h", "until_tomorrow", "indefinite", …)
   *   - `customExpiresAt`: when the operator picked "custom date"
   *
   * `indefinite` stores expiresAt=null — must explicitly unsnooze.
   *
   * Side-effect: if the item has a HubRise SKU ref (set during import),
   * also PATCH HubRise's inventory. Best-effort, doesn't fail the snooze.
   */
  async snooze(args: {
    itemId: string;
    tenantId: string;
    userId?: string;
    channel: SupportedChannel;
    duration?: DurationPreset;
    customExpiresAt?: string;
    snoozeReason?: string;
  }) {
    const item = await this.assertItemAccess(args.itemId, args.tenantId);
    const expiresAt = this.resolveExpiry(args.duration, args.customExpiresAt);

    const row = await (this.prisma as any).menuItemChannelAvailability.upsert({
      where: {
        itemId_channel: { itemId: args.itemId, channel: args.channel },
      },
      create: {
        itemId: args.itemId,
        channel: args.channel,
        isAvailable: false,
        expiresAt,
        snoozeReason: args.snoozeReason ?? null,
        snoozedBy: args.userId ?? null,
        snoozedAt: new Date(),
      },
      update: {
        isAvailable: false,
        expiresAt,
        snoozeReason: args.snoozeReason ?? null,
        snoozedBy: args.userId ?? null,
        snoozedAt: new Date(),
      },
    });

    // Fire-and-forget HubRise sync.
    this.pushToHubRiseIfApplicable(item, "OUT", expiresAt).catch((err) =>
      this.logger.warn(
        `HubRise inventory PATCH failed for item ${item.id} channel ${args.channel}: ${err?.message ?? err}`,
      ),
    );

    // Fire-and-forget direct Deliveroo sync (replace-all snapshot).
    if (args.channel === "DELIVEROO") {
      this.syncDeliverooAvailability(args.itemId, args.tenantId).catch((err) =>
        this.logger.warn(
          `Deliveroo item_unavailabilities sync failed for item ${args.itemId}: ${err?.message ?? err}`,
        ),
      );
    }

    // Fire-and-forget direct Uber Eats sync (sparse Update Menu Item).
    if (args.channel === "UBER_EATS") {
      this.syncUberEatsAvailability(item, args.tenantId, expiresAt, args.snoozeReason ?? null).catch(
        (err) => {
          this.logger.warn(
            `Uber Eats item suspension failed for item ${args.itemId}: ${err?.message ?? err}`,
          );
          this.activity?.record({
            tenantId: args.tenantId,
            brandId: (item as any).brandId ?? null,
            category: "INVENTORY",
            channel: "UBER_EATS",
            action: "item.86.push",
            status: "ERROR",
            message: `Uber Eats suspension push crashed: ${err?.message ?? err}`,
            details: { itemId: args.itemId },
          });
        },
      );
    }

    this.activity?.record({
      tenantId: args.tenantId,
      brandId: (item as any).brandId ?? null,
      category: "INVENTORY",
      channel: args.channel,
      action: "item.86",
      status: "WARNING",
      message: `"${(item as any).name ?? args.itemId}" marked unavailable on ${args.channel}${expiresAt ? ` until ${expiresAt.toISOString()}` : ""}`,
      details: { itemId: args.itemId, reason: args.snoozeReason ?? null },
    });

    return row;
  }

  /**
   * Unsnooze — flip the item back to available for the given channel.
   * Row gets deleted; absence = available.
   */
  async unsnooze(args: {
    itemId: string;
    tenantId: string;
    channel: SupportedChannel;
  }) {
    const item = await this.assertItemAccess(args.itemId, args.tenantId);

    await (this.prisma as any).menuItemChannelAvailability
      .delete({
        where: {
          itemId_channel: { itemId: args.itemId, channel: args.channel },
        },
      })
      .catch(() => null);

    this.pushToHubRiseIfApplicable(item, "IN", null).catch((err) =>
      this.logger.warn(
        `HubRise inventory PATCH (restore) failed for item ${item.id} channel ${args.channel}: ${err?.message ?? err}`,
      ),
    );

    if (args.channel === "DELIVEROO") {
      this.syncDeliverooAvailability(args.itemId, args.tenantId).catch((err) =>
        this.logger.warn(
          `Deliveroo item_unavailabilities sync failed for item ${args.itemId}: ${err?.message ?? err}`,
        ),
      );
    }

    // Restore on Uber: suspension null = back on sale.
    if (args.channel === "UBER_EATS") {
      this.syncUberEatsAvailability(item, args.tenantId, null, null, true).catch(
        (err) => {
          this.logger.warn(
            `Uber Eats item restore failed for item ${args.itemId}: ${err?.message ?? err}`,
          );
          this.activity?.record({
            tenantId: args.tenantId,
            brandId: (item as any).brandId ?? null,
            category: "INVENTORY",
            channel: "UBER_EATS",
            action: "item.restore.push",
            status: "ERROR",
            message: `Uber Eats restore push crashed: ${err?.message ?? err}`,
            details: { itemId: args.itemId },
          });
        },
      );
    }

    this.activity?.record({
      tenantId: args.tenantId,
      brandId: (item as any).brandId ?? null,
      category: "INVENTORY",
      channel: args.channel,
      action: "item.restore",
      status: "SUCCESS",
      message: `"${(item as any).name ?? args.itemId}" back in stock on ${args.channel}`,
      details: { itemId: args.itemId },
    });

    return { ok: true };
  }

  /**
   * Push the brand's current DELIVEROO 86 state to Deliveroo.
   *
   * Deliveroo's item_unavailabilities endpoint is a COMPLETE OVERRIDE — one
   * PUT replaces the whole unavailable set for the menu/site. So on every
   * DELIVEROO snooze/unsnooze we recompute the full set of currently-snoozed
   * items in the brand's Deliveroo-published menu and send them all. Item ids
   * mirror what the menu publish emitted: our MenuItem.id for single-price
   * items, and `${id}__s{n}` per size for multi-SKU products.
   *
   * No-ops (silently) when the brand isn't connected to Deliveroo or has no
   * menu published there — nothing to sync.
   */
  /**
   * Push a single item's 86 state to Uber Eats the way Uber specifies:
   * sparse Update Menu Item with suspension_info (suspend_until epoch
   * seconds; null restores). Multi-SKU products also push every size id
   * (`${id}__s{n}`, same ids the menu publish emitted); 404s for ids not on
   * the live menu are tolerated.
   */
  private async syncUberEatsAvailability(
    item: any,
    tenantId: string,
    expiresAt: Date | null,
    reason: string | null,
    restore = false,
  ): Promise<void> {
    // The Uber store may be connected to a DIFFERENT brand than the item's
    // own (e.g. a HubRise-imported item whose menu was later published under
    // a virtual brand). Resolve through every brand the item is reachable
    // from: its own brand, shared brands, and the brands of its menus.
    const candidateBrands = new Set<string>();
    if ((item as any).brandId) candidateBrands.add((item as any).brandId);
    for (const b of ((item as any).brandIds ?? []) as string[]) {
      if (b) candidateBrands.add(b);
    }
    const menuIds = (((item as any).menuIds ?? []) as string[]).filter(Boolean);
    if (menuIds.length) {
      const menus = await this.prisma.menu.findMany({
        where: { id: { in: menuIds } },
        select: { brandId: true },
      });
      for (const m of menus) if (m.brandId) candidateBrands.add(m.brandId);
    }
    const conn = candidateBrands.size
      ? await this.prisma.brandPlatformConnection.findFirst({
          where: {
            brandId: { in: Array.from(candidateBrands) },
            tenantId,
            platform: "UBER_EATS",
            externalStoreId: { not: null },
            status: { in: ["connected", "suspended"] },
          },
          select: { externalStoreId: true, locationId: true, brandId: true },
        })
      : null;
    if (!conn?.externalStoreId) {
      // Never skip silently — say exactly why nothing reached Uber.
      this.activity?.record({
        tenantId,
        brandId: (item as any).brandId ?? null,
        category: "INVENTORY",
        channel: "UBER_EATS",
        action: restore ? "item.restore.push" : "item.86.push",
        status: "WARNING",
        message: `"${(item as any).name ?? item.id}" ${restore ? "restore" : "86"} NOT pushed — no connected Uber Eats store found for this item's brands`,
        details: { itemId: item.id, candidateBrands: Array.from(candidateBrands) },
      });
      return;
    }
    const brandId = conn.brandId;

    // Uber's "forever" convention (same constant the menu publish uses) —
    // far-future epoch; a timed snooze uses its real expiry.
    const FOREVER = 8_640_000_000;
    const suspendUntil = restore
      ? null
      : expiresAt
        ? Math.floor(expiresAt.getTime() / 1000)
        : FOREVER;

    const ids: string[] = [item.id];
    const skus = Array.isArray((item as any).productSkus)
      ? ((item as any).productSkus as any[])
      : [];
    if ((item as any).hasMultipleSkus && skus.length > 0) {
      skus.forEach((_, i) => ids.push(`${item.id}__s${i}`));
    }

    // Resolve against Uber's LIVE menu so the item_id we PATCH is the one Uber
    // actually holds (our publish uses our id, but imports/re-uploads can
    // drift). Match by id → external_data(PLU) → name. Prevents the 404 the
    // Uber docs warn about when the item isn't on the uploaded menu.
    const resolved = await this.uberEatsMenu.resolveLiveItemIds(
      conn.externalStoreId,
      ids,
      { plu: (item as any).plu ?? null, name: (item as any).name ?? null },
    );
    if (resolved.ids.length === 0) {
      this.activity?.record({
        tenantId,
        brandId,
        locationId: conn.locationId ?? null,
        category: "INVENTORY",
        channel: "UBER_EATS",
        action: restore ? "item.restore.push" : "item.86.push",
        status: "WARNING",
        message: `"${(item as any).name ?? item.id}" ${restore ? "restore" : "86"} skipped — item not found on Uber's live menu (${resolved.liveCount} items). Publish this menu to Uber Eats, then retry.`,
        details: {
          triedIds: ids,
          liveSampleIds: resolved.sampleIds,
          matchedBy: resolved.matchedBy,
        },
      });
      this.logger.warn(
        `Uber 86: item ${item.id} not on live menu (${resolved.liveCount} items). Sample live ids: ${resolved.sampleIds.join(",")}`,
      );
      return;
    }
    this.logger.log(
      `Uber 86: resolved ${resolved.ids.length} live id(s) for ${item.id} via ${resolved.matchedBy} → [${resolved.ids.join(",")}]`,
    );

    const { results } = await this.uberEatsMenu.setItemSuspension({
      storeId: conn.externalStoreId,
      itemIds: resolved.ids,
      suspendUntil,
      reason: reason ?? undefined,
    });
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    this.logger.log(
      `Uber Eats item ${restore ? "restore" : "86"} for ${item.id}: ${ok.length}/${results.length} ok` +
        (failed.length ? ` (failed: ${failed.map((f) => f.itemId).join(",")})` : ""),
    );
    this.activity?.record({
      tenantId,
      brandId,
      locationId: conn.locationId ?? null,
      category: "INVENTORY",
      channel: "UBER_EATS",
      action: restore ? "item.restore.push" : "item.86.push",
      status: failed.length === results.length ? "ERROR" : "SUCCESS",
      message: `"${(item as any).name ?? item.id}" ${restore ? "back on sale" : "suspended"} on Uber Eats — Uber responded ${ok[0]?.httpStatus ?? failed[0]?.httpStatus ?? "ERR"}${suspendUntil && !restore && expiresAt ? ` (until ${expiresAt.toISOString()})` : ""}`,
      details: { results, suspendUntil },
    });
  }

  private async syncDeliverooAvailability(
    itemId: string,
    tenantId: string,
  ): Promise<void> {
    // Resolve the Deliveroo-published menu that CONTAINS this item — not by
    // the item's own brandId, which in a multi-brand kitchen can differ from
    // the brand the menu was published under (that brand owns the Deliveroo
    // connection). Its Deliveroo menu id = our Menu.id.
    const menu = await this.prisma.menu.findFirst({
      where: {
        deletedAt: null,
        publishedTo: { has: "DELIVEROO" },
        brand: { tenantId },
        categories: { some: { items: { some: { itemId } } } },
      },
      orderBy: { lastPublishedAt: "desc" },
      select: { id: true, brandId: true },
    });
    if (!menu) {
      this.logger.log(
        `Deliveroo 86 skip: item ${itemId} isn't on a Deliveroo-published menu`,
      );
      return;
    }

    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: menu.brandId,
        tenantId,
        platform: "DELIVEROO",
        externalStoreId: { not: null },
        externalBrandId: { not: null },
      },
      select: { externalStoreId: true, externalBrandId: true },
    });
    if (!conn) {
      this.logger.warn(
        `Deliveroo 86 skip: brand ${menu.brandId} (menu ${menu.id}) has no connected Deliveroo store`,
      );
      return;
    }

    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId: menu.id },
      select: { items: { select: { itemId: true } } },
    });
    const itemIds: string[] = Array.from(
      new Set(
        cats.flatMap((c: any) =>
          (c.items ?? []).map((l: any) => String(l.itemId)),
        ),
      ),
    );

    const snoozedIds = await this.getSnoozedItemIdsForChannel(
      "DELIVEROO",
      itemIds,
    );

    // Expand multi-SKU products to their per-size Deliveroo item ids.
    const unavailable: string[] = [];
    if (snoozedIds.size > 0) {
      const items = await this.prisma.menuItem.findMany({
        where: { id: { in: Array.from(snoozedIds) } },
        select: { id: true, hasMultipleSkus: true, productSkus: true },
      });
      for (const it of items) {
        const skus =
          it.hasMultipleSkus && Array.isArray(it.productSkus)
            ? (it.productSkus as any[])
            : [];
        if (skus.length > 0) {
          skus.forEach((_, i) => unavailable.push(`${it.id}__s${i}`));
        } else {
          unavailable.push(it.id);
        }
      }
    }

    await this.deliverooClient.request(
      "PUT",
      `/menu/v1/brands/${conn.externalBrandId}/menus/${encodeURIComponent(
        menu.id,
      )}/item_unavailabilities/${conn.externalStoreId}`,
      { unavailable_ids: unavailable, hidden_ids: [] },
    );
    this.logger.log(
      `Deliveroo item_unavailabilities menu=${menu.id} site=${conn.externalStoreId}: ${unavailable.length} unavailable`,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async assertItemAccess(itemId: string, tenantId: string) {
    // Two-step tenant guard: fetch the item, then verify its brand
    // belongs to the caller. The relation-filtered findFirst isn't
    // available on this Prisma client's MenuItemWhereInput, so two
    // round-trips it is.
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        name: true,
        brandId: true,
        brandIds: true,
        menuIds: true,
        plu: true,
        hasMultipleSkus: true,
        productSkus: true,
        externalId: true,
        platformSource: true,
      },
    });
    if (!item) throw new NotFoundException(`Item ${itemId} not found`);
    const brand = await this.prisma.brand.findUnique({
      where: { id: item.brandId },
      select: { tenantId: true },
    });
    if (brand?.tenantId !== tenantId) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    return item;
  }

  /**
   * Translate the operator's duration choice into an absolute UTC
   * expiry. `until_tomorrow` = 09:00 server-tomorrow — matches what
   * most restaurant POS systems mean by "until tomorrow".
   */
  private resolveExpiry(
    duration?: DurationPreset,
    customExpiresAt?: string,
  ): Date | null {
    if (customExpiresAt) {
      const d = new Date(customExpiresAt);
      if (isNaN(d.getTime())) {
        throw new BadRequestException("Invalid customExpiresAt");
      }
      return d;
    }
    if (!duration) return null;
    if (duration === "indefinite") return null;
    if (duration === "until_tomorrow") {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      return t;
    }
    const hoursByPreset: Record<string, number> = {
      "1h": 1,
      "2h": 2,
      "4h": 4,
      "6h": 6,
      "12h": 12,
    };
    const hours = hoursByPreset[duration];
    if (!hours) throw new BadRequestException(`Unknown duration: ${duration}`);
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  /**
   * Push snooze through to HubRise's inventory endpoint. Sends the
   * SKU(s)' refs (stored in MenuItem.plu / productSkus[].plu by
   * import). Best-effort — reach-fail logged, doesn't block snooze.
   *
   * Single-PATCH for all known SKU refs on the item: handles both
   * single-SKU products (one plu) and multi-SKU products (one ref per
   * productSkus[] entry).
   */
  private async pushToHubRiseIfApplicable(
    item: any,
    mode: "OUT" | "IN",
    expiresAt: Date | null,
  ) {
    const skuRefs = new Set<string>();
    if (item.plu) skuRefs.add(item.plu);
    if (item.hasMultipleSkus && Array.isArray(item.productSkus)) {
      for (const s of item.productSkus as any[]) {
        if (s?.plu) skuRefs.add(s.plu);
      }
    }
    if (skuRefs.size === 0) return;

    const location = await this.prisma.location.findFirst({
      where: {
        brandId: item.brandId,
        hubriseCatalogId: { not: null },
        hubriseLocationId: { not: null },
      },
      select: {
        id: true,
        hubriseCredentials: true,
        hubriseCatalogId: true,
        hubriseLocationId: true,
      },
    });
    if (!location) return;

    await this.hubrise.patchInventory({
      catalogId: location.hubriseCatalogId!,
      hubriseLocationId: location.hubriseLocationId!,
      credentialsBlob: location.hubriseCredentials,
      entries: Array.from(skuRefs).map((sku_ref) => ({
        sku_ref,
        stock: mode === "OUT" ? "0" : null,
        expires_at: mode === "OUT" && expiresAt ? expiresAt.toISOString() : null,
      })),
    });
  }
}
