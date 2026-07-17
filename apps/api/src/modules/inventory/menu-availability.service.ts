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
// Phase BA: "ALL" is a sentinel meaning "every channel" — written by the
// menu/products-page location toggle ("86 here entirely") and matched by
// the read filter alongside the specific channel.
export type SupportedChannel =
  | "ONLINE"
  | "POS"
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "WHATSAPP"
  | "HUBRISE"
  | "ALL";

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
  async getBrandMatrix(brandId: string, tenantId: string, locationId?: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    if (locationId) await this.assertLocationInTenant(locationId, tenantId);

    // Scope to the menu customers actually see. Phase BA: when the board is
    // opened with a location context, the latest serving assignment for
    // (location, brand) — any channel — wins; otherwise (and as fallback)
    // the brand's most recently published menu, matching pre-BA behaviour.
    //
    // Final fallback: a brand with no published menu yet keeps the old
    // behaviour — items tagged to the brand (primary brandId or shared via
    // brandIds) — so the board isn't empty before the first publish.
    let lastPublished: { id: string; name: string } | null = null;
    // Primary: the most recent serving assignment for this BRAND. Assignments
    // stamp the brand at publish time, so this resolves the menu even when it's
    // a master/shared/variant menu whose own menu.brandId differs from this
    // brand (e.g. a variant menu published for this brand on Online/HubRise —
    // the exact case where the brand-only fallback below missed it). Scope to
    // the location when one is supplied; otherwise take the brand's latest
    // across every location/channel. isActive is intentionally NOT required —
    // inventory shows the LAST PUBLISHED menu, even if the auto-schedule worker
    // has it toggled off right now.
    const assignment = await (
      this.prisma as any
    ).menuChannelAssignment.findFirst({
      where: {
        brandId,
        ...(locationId ? { locationId } : {}),
        menu: { deletedAt: null },
      },
      orderBy: { publishedAt: "desc" },
      select: { menu: { select: { id: true, name: true } } },
    });
    lastPublished = assignment?.menu ?? null;
    if (!lastPublished) {
      // Fallback for menus published before assignments existed (or via a path
      // that doesn't write them): the brand's own most-recently-published menu.
      lastPublished = await this.prisma.menu.findFirst({
        where: { brandId, deletedAt: null, lastPublishedAt: { not: null } },
        orderBy: { lastPublishedAt: "desc" },
        select: { id: true, name: true },
      });
    }

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

    // Fetch the served menu's items, then decide whether to brand-scope them.
    //
    // ROOT-CAUSE FIX: the old code ALWAYS filtered items to the selected
    // brand (own brandId or brandIds). That silently emptied the board when a
    // menu's items belong to a brand OTHER than this location's brand chip —
    // e.g. a menu imported/cloned under one brand but published to SERVE at a
    // location whose brand is different. Every item was filtered out.
    //
    // The rule (per the operator): if the menu mixes MULTIPLE brands (a
    // master/variant menu), scope to this brand's items only; if it's a
    // single-brand menu, show ALL its items — even if that brand differs from
    // the location's brand chip, because the whole menu is what's served here.
    const allItems = await this.prisma.menuItem.findMany({
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
        brandId: true,
        brandIds: true,
      },
      orderBy: { name: "asc" },
    });
    const distinctBrands = new Set(allItems.map((i) => i.brandId));
    const scoped =
      distinctBrands.size > 1
        ? allItems.filter(
            (i) =>
              i.brandId === brandId || (i.brandIds ?? []).includes(brandId),
          )
        : allItems;

    // Collapse duplicate products into one row. A menu combined from several
    // source menus (master menu) or re-imported can carry multiple MenuItem
    // records for the SAME product — sometimes at slightly different prices, so
    // we key on BRAND + name (not price). Same name under different brands
    // (e.g. each brand's "Fries") is kept separate. Keep the copy that has a
    // real PLU/SKU (the original import) so its identity/snoozes survive.
    const seen = new Map<string, (typeof scoped)[number]>();
    for (const it of scoped) {
      const key = `${it.brandId ?? ""}|${(it.name ?? "").trim().toLowerCase()}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, it);
      } else if (!existing.plu && it.plu) {
        // Prefer the one carrying a PLU (the source item) over a bare clone.
        seen.set(key, it);
      }
    }
    const items = Array.from(seen.values());
    if (items.length === 0) return { items: [] };

    const now = new Date();
    const snoozes = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        itemId: { in: items.map((i) => i.id) },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          // Phase BA — with a location context show global rows + that
          // location's own; without one, only global rows (pre-BA view).
          locationId
            ? { OR: [{ locationId: null }, { locationId }] }
            : { locationId: null },
        ],
      },
      // Global rows first so a location-scoped row for the same channel
      // overwrites it in the map below — the board shows the state that
      // actually applies HERE, with locationId telling the UI the scope.
      orderBy: { locationId: { sort: "asc", nulls: "first" } },
    });
    const byItem = new Map<string, Record<string, any>>();
    for (const s of snoozes) {
      if (!byItem.has(s.itemId)) byItem.set(s.itemId, {});
      byItem.get(s.itemId)![s.channel] = {
        expiresAt: s.expiresAt,
        snoozeReason: s.snoozeReason,
        snoozedAt: s.snoozedAt,
        snoozedBy: s.snoozedBy,
        // null = applies at every location; a location id = scoped here.
        locationId: s.locationId ?? null,
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
   *
   * Phase BA — location scoping. Global rows (locationId NULL) apply
   * everywhere; a `locationId` argument ALSO matches that location's own
   * rows. Callers that don't pass a location see only global rows, so a
   * location-scoped 86 can never leak into an unscoped surface. "ALL"
   * channel rows (the "86 here entirely" toggle) count on every channel.
   */
  async getSnoozedItemIdsForChannel(
    channel: SupportedChannel,
    candidateItemIds: string[],
    locationId?: string,
  ): Promise<Set<string>> {
    if (candidateItemIds.length === 0) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        channel: { in: [channel, "ALL"] },
        itemId: { in: candidateItemIds },
        // Both disjunctions must hold — nest under AND, a top-level pair
        // of OR keys would overwrite each other in the where object.
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          locationId
            ? { OR: [{ locationId: null }, { locationId }] }
            : { locationId: null },
        ],
      },
      select: { itemId: true },
    });
    return new Set(rows.map((r: { itemId: string }) => r.itemId));
  }

  /**
   * Phase BA — itemIds 86'd "entirely" at one location (channel "ALL",
   * unexpired). Backs the products-tab availability toggle display.
   */
  async getLocationAllChannelSnoozedItemIds(
    locationId: string,
    tenantId: string,
  ): Promise<Set<string>> {
    await this.assertLocationInTenant(locationId, tenantId);
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        channel: "ALL",
        locationId,
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
    /** Phase BA — scope the 86 to one location. Absent = all locations. */
    locationId?: string;
  }) {
    const item = await this.assertItemAccess(args.itemId, args.tenantId);
    if (args.locationId) {
      await this.assertLocationInTenant(args.locationId, args.tenantId);
    }
    const expiresAt = this.resolveExpiry(args.duration, args.customExpiresAt);

    const writeFields = {
      isAvailable: false,
      expiresAt,
      snoozeReason: args.snoozeReason ?? null,
      snoozedBy: args.userId ?? null,
      snoozedAt: new Date(),
    };

    // Location rows upsert on the compound key. Global rows (locationId
    // NULL) can't — Postgres NULLs are distinct in the compound unique —
    // so findFirst→update|create, backstopped by the partial unique index.
    let row;
    if (args.locationId) {
      row = await (this.prisma as any).menuItemChannelAvailability.upsert({
        where: {
          itemId_channel_locationId: {
            itemId: args.itemId,
            channel: args.channel,
            locationId: args.locationId,
          },
        },
        create: {
          itemId: args.itemId,
          channel: args.channel,
          locationId: args.locationId,
          ...writeFields,
        },
        update: writeFields,
      });
    } else {
      const existing = await (
        this.prisma as any
      ).menuItemChannelAvailability.findFirst({
        where: { itemId: args.itemId, channel: args.channel, locationId: null },
        select: { id: true },
      });
      row = existing
        ? await (this.prisma as any).menuItemChannelAvailability.update({
            where: { id: existing.id },
            data: writeFields,
          })
        : await (this.prisma as any).menuItemChannelAvailability.create({
            data: {
              itemId: args.itemId,
              channel: args.channel,
              locationId: null,
              ...writeFields,
            },
          });
    }

    // Fire-and-forget HubRise sync (location-scoped writes only touch that
    // location's catalog; "ALL"-channel rows count on HUBRISE too).
    this.pushToHubRiseIfApplicable(item, "OUT", expiresAt, args.locationId).catch((err) =>
      this.logger.warn(
        `HubRise inventory PATCH failed for item ${item.id} channel ${args.channel}: ${err?.message ?? err}`,
      ),
    );

    // Fire-and-forget direct Deliveroo sync (replace-all snapshot).
    if (args.channel === "DELIVEROO" || args.channel === "ALL") {
      this.syncDeliverooAvailability(args.itemId, args.tenantId, args.locationId).catch((err) =>
        this.logger.warn(
          `Deliveroo item_unavailabilities sync failed for item ${args.itemId}: ${err?.message ?? err}`,
        ),
      );
    }

    // Fire-and-forget direct Uber Eats sync (sparse Update Menu Item).
    if (args.channel === "UBER_EATS" || args.channel === "ALL") {
      this.syncUberEatsAvailability(item, args.tenantId, expiresAt, args.snoozeReason ?? null, false, args.locationId).catch(
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
      locationId: args.locationId ?? null,
      category: "INVENTORY",
      channel: args.channel,
      action: "item.86",
      status: "WARNING",
      message: `"${(item as any).name ?? args.itemId}" marked unavailable on ${args.channel === "ALL" ? "every channel" : args.channel}${args.locationId ? " at this location" : ""}${expiresAt ? ` until ${expiresAt.toISOString()}` : ""}`,
      details: {
        itemId: args.itemId,
        reason: args.snoozeReason ?? null,
        locationId: args.locationId ?? null,
      },
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
    /** Phase BA — un-86 for one location. Absent = the global row. */
    locationId?: string;
  }) {
    const item = await this.assertItemAccess(args.itemId, args.tenantId);
    if (args.locationId) {
      await this.assertLocationInTenant(args.locationId, args.tenantId);
    }

    // Location-scoped unsnooze deletes that location's row; when the item
    // was 86'd GLOBALLY the operator's intent is still "sellable here", and
    // a per-location "available again" can't override a global row at read
    // time — so fall back to deleting the global row (the board labels
    // global chips "All locations", making the wider effect visible).
    const deleted = await (
      this.prisma as any
    ).menuItemChannelAvailability.deleteMany({
      where: {
        itemId: args.itemId,
        channel: args.channel,
        locationId: args.locationId ?? null,
      },
    });
    if (args.locationId && deleted.count === 0) {
      await (this.prisma as any).menuItemChannelAvailability.deleteMany({
        where: { itemId: args.itemId, channel: args.channel, locationId: null },
      });
    }

    this.pushToHubRiseIfApplicable(item, "IN", null, args.locationId).catch((err) =>
      this.logger.warn(
        `HubRise inventory PATCH (restore) failed for item ${item.id} channel ${args.channel}: ${err?.message ?? err}`,
      ),
    );

    if (args.channel === "DELIVEROO" || args.channel === "ALL") {
      this.syncDeliverooAvailability(args.itemId, args.tenantId, args.locationId).catch((err) =>
        this.logger.warn(
          `Deliveroo item_unavailabilities sync failed for item ${args.itemId}: ${err?.message ?? err}`,
        ),
      );
    }

    // Restore on Uber: suspension null = back on sale. Guard: another row
    // may still 86 this item on Uber at this location (an "ALL" row after a
    // UBER_EATS unsnooze, or vice versa) — recompute effective state and
    // skip the restore push while anything still applies.
    const stillOutOnUber =
      (args.channel === "UBER_EATS" || args.channel === "ALL") &&
      (
        await this.getSnoozedItemIdsForChannel(
          "UBER_EATS",
          [args.itemId],
          args.locationId,
        )
      ).has(args.itemId);
    if ((args.channel === "UBER_EATS" || args.channel === "ALL") && !stillOutOnUber) {
      this.syncUberEatsAvailability(item, args.tenantId, null, null, true, args.locationId).catch(
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
      locationId: args.locationId ?? null,
      category: "INVENTORY",
      channel: args.channel,
      action: "item.restore",
      status: "SUCCESS",
      message: `"${(item as any).name ?? args.itemId}" back in stock on ${args.channel === "ALL" ? "every channel" : args.channel}${args.locationId ? " at this location" : ""}`,
      details: { itemId: args.itemId, locationId: args.locationId ?? null },
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
    locationId?: string,
  ): Promise<void> {
    // Base44-verified model: DON'T resolve the store from the item's brand
    // (a shared item's brand often differs from the brand that published the
    // menu to Uber). Instead loop over ALL the tenant's connected Uber stores
    // and use each store's LIVE menu as the source of truth — suspend on the
    // store(s) where the item actually resolves (by id → PLU → name).
    //
    // Phase BA — a location-scoped 86 only touches that location's store
    // connection(s); global writes keep fanning out to every store.
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "UBER_EATS",
        externalStoreId: { not: null },
        status: { in: ["connected", "suspended"] },
        ...(locationId ? { locationId } : {}),
      },
      select: { externalStoreId: true, locationId: true, brandId: true },
    });
    if (conns.length === 0) {
      this.activity?.record({
        tenantId,
        brandId: (item as any).brandId ?? null,
        category: "INVENTORY",
        channel: "UBER_EATS",
        action: restore ? "item.restore.push" : "item.86.push",
        status: "WARNING",
        message: `"${(item as any).name ?? item.id}" ${restore ? "restore" : "86"} NOT pushed — no Uber Eats store connected for this account`,
        details: { itemId: item.id },
      });
      return;
    }

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

    // Try each connected store: resolve the item on its live menu, and push
    // the suspension only where it exists. Aggregate for one clear Logs row.
    type Pushed = {
      storeId: string;
      brandId: string;
      locationId: string | null;
      matchedBy: string;
      results: Array<{ itemId: string; httpStatus: number | null; error?: string }>;
    };
    const pushed: Pushed[] = [];
    let liveSample: string[] = [];
    let liveCount = 0;
    for (const c of conns) {
      const resolved = await this.uberEatsMenu.resolveLiveItemIds(
        c.externalStoreId!,
        ids,
        { plu: (item as any).plu ?? null, name: (item as any).name ?? null },
      );
      if (resolved.sampleIds.length) liveSample = resolved.sampleIds;
      liveCount = Math.max(liveCount, resolved.liveCount);
      if (resolved.ids.length === 0) continue;
      const { results } = await this.uberEatsMenu.setItemSuspension({
        storeId: c.externalStoreId!,
        itemIds: resolved.ids,
        suspendUntil,
        reason: reason ?? undefined,
      });
      pushed.push({
        storeId: c.externalStoreId!,
        brandId: c.brandId,
        locationId: c.locationId ?? null,
        matchedBy: resolved.matchedBy,
        results,
      });
    }

    if (pushed.length === 0) {
      this.activity?.record({
        tenantId,
        brandId: (item as any).brandId ?? null,
        category: "INVENTORY",
        channel: "UBER_EATS",
        action: restore ? "item.restore.push" : "item.86.push",
        status: "WARNING",
        message: `"${(item as any).name ?? item.id}" ${restore ? "restore" : "86"} skipped — not on any connected Uber store's live menu (checked ${conns.length}, ${liveCount} items). Publish this menu to Uber Eats first.`,
        details: {
          triedIds: ids,
          storesChecked: conns.map((c) => c.externalStoreId),
          liveSampleIds: liveSample,
          plu: (item as any).plu ?? null,
          name: (item as any).name ?? null,
        },
      });
      this.logger.warn(
        `Uber 86: item ${item.id} not found on any of ${conns.length} store(s). Sample live ids: ${liveSample.join(",")}`,
      );
      return;
    }

    const allResults = pushed.flatMap((p) => p.results);
    const ok = allResults.filter((r) => !r.error);
    const failed = allResults.filter((r) => r.error);
    this.logger.log(
      `Uber Eats item ${restore ? "restore" : "86"} for ${item.id}: ${ok.length}/${allResults.length} ok across ${pushed.length} store(s)`,
    );
    this.activity?.record({
      tenantId,
      brandId: pushed[0]!.brandId,
      locationId: pushed[0]!.locationId,
      category: "INVENTORY",
      channel: "UBER_EATS",
      action: restore ? "item.restore.push" : "item.86.push",
      status: failed.length === allResults.length ? "ERROR" : "SUCCESS",
      message: `"${(item as any).name ?? item.id}" ${restore ? "back on sale" : "suspended"} on Uber Eats (${pushed.length} store${pushed.length === 1 ? "" : "s"}, matched by ${pushed[0]!.matchedBy}) — Uber responded ${ok[0]?.httpStatus ?? failed[0]?.httpStatus ?? "ERR"}${suspendUntil && !restore && expiresAt ? ` (until ${expiresAt.toISOString()})` : ""}`,
      details: { pushed, suspendUntil },
    });
  }

  private async syncDeliverooAvailability(
    itemId: string,
    tenantId: string,
    locationId?: string,
  ): Promise<void> {
    // Phase BA — resolve every (menu, location) actually SERVING this item
    // on Deliveroo via the assignment rows, and recompute each store's
    // unavailable set with that location's snoozes. A location-scoped write
    // syncs only that location's store; a global write syncs them all.
    // Falls back to the pre-BA single-menu lookup for tenants that haven't
    // re-published since the assignment migration.
    type Target = { menuId: string; brandId: string; locationId: string | null };
    let targets: Target[] = (
      await (this.prisma as any).menuChannelAssignment.findMany({
        where: {
          channel: "DELIVEROO",
          ...(locationId ? { locationId } : {}),
          menu: {
            deletedAt: null,
            isActive: true,
            brand: { tenantId },
            categories: { some: { items: { some: { itemId } } } },
          },
        },
        select: { menuId: true, brandId: true, locationId: true },
      })
    ).map((a: any) => ({
      menuId: a.menuId,
      brandId: a.brandId,
      locationId: a.locationId,
    }));

    if (targets.length === 0) {
      // Legacy: menu that contains the item, published to Deliveroo — not by
      // the item's own brandId, which in a multi-brand kitchen can differ
      // from the brand that owns the Deliveroo connection.
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
      targets = [{ menuId: menu.id, brandId: menu.brandId, locationId: locationId ?? null }];
    }

    for (const target of targets) {
      const conn = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          brandId: target.brandId,
          tenantId,
          platform: "DELIVEROO",
          externalStoreId: { not: null },
          externalBrandId: { not: null },
          ...(target.locationId ? { locationId: target.locationId } : {}),
        },
        select: { externalStoreId: true, externalBrandId: true },
      }) ??
        // A brand-level connection without a location pin still serves.
        (await this.prisma.brandPlatformConnection.findFirst({
          where: {
            brandId: target.brandId,
            tenantId,
            platform: "DELIVEROO",
            externalStoreId: { not: null },
            externalBrandId: { not: null },
          },
          select: { externalStoreId: true, externalBrandId: true },
        }));
      if (!conn) {
        this.logger.warn(
          `Deliveroo 86 skip: brand ${target.brandId} (menu ${target.menuId}) has no connected Deliveroo store`,
        );
        continue;
      }

      const cats = await this.prisma.menuCategory.findMany({
        where: { menuId: target.menuId },
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
        target.locationId ?? undefined,
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
          target.menuId,
        )}/item_unavailabilities/${conn.externalStoreId}`,
        { unavailable_ids: unavailable, hidden_ids: [] },
      );
      this.logger.log(
        `Deliveroo item_unavailabilities menu=${target.menuId} site=${conn.externalStoreId}: ${unavailable.length} unavailable`,
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /** Phase BA — a caller-supplied locationId must belong to the tenant. */
  private async assertLocationInTenant(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

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
    locationId?: string,
  ) {
    // Build the SKU refs EXACTLY as transformMenuToCatalog does when it
    // publishes the catalog — otherwise the 86 targets a ref HubRise doesn't
    // have and silently no-ops. That's the bug for cloned menus: cloning clears
    // PLUs, so the catalog falls back to `<itemId>_sku`, but this sync only knew
    // how to send `item.plu`. Match the publish path ref-for-ref.
    const skuRefs = new Set<string>();
    if (
      item.hasMultipleSkus &&
      Array.isArray(item.productSkus) &&
      item.productSkus.length > 0
    ) {
      (item.productSkus as any[]).forEach((s, i) => {
        skuRefs.add(s?.plu ?? `${item.id}_sku_${i}`);
      });
    } else {
      skuRefs.add(item.plu ?? item.externalId ?? `${item.id}_sku`);
    }
    if (skuRefs.size === 0) return;

    // Phase BA — a location-scoped 86 patches THAT location's HubRise catalog
    // only. NEVER a deleted location (deletedAt filter) — a stale/removed
    // location can still hold an orphaned catalog id and would swallow the
    // update. Global writes fall back to the brand's live connected location.
    const location = await this.prisma.location.findFirst({
      where: {
        ...(locationId ? { id: locationId } : { brandId: item.brandId }),
        deletedAt: null,
        hubriseCatalogId: { not: null },
        hubriseLocationId: { not: null },
      },
      orderBy: { updatedAt: "desc" },
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
