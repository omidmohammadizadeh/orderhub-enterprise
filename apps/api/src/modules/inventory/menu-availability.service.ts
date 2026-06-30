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
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { HubRiseCatalogService } from "../integrations/hubrise/hubrise-catalog.service";

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

    // Phase AW-14 fix — items can live on this brand via two paths:
    //   (a) MenuItem.brandId === brand.id  (created directly under it)
    //   (b) reachable via Menu.brandId === brand.id → MenuCategory →
    //       MenuItemOnCategory → MenuItem  (a menu the operator
    //       reassigned to this brand at publish time, whose items still
    //       carry their original brandId).
    // An item belongs to this brand when it's its primary brand OR it's
    // shared to it (brandIds). We deliberately do NOT match by the menu's
    // brandId: a shared HubRise menu has one Menu.brandId for all brands, so
    // matching on it would lump every item under that one brand. Tagging each
    // product's brand (product form → Brands) is what scopes it here — so
    // Margherita shows under Pizza Uno and Cheese Burger under Monster Burgerz.
    const menuItemIds = await this.prisma.menuItem.findMany({
      where: {
        OR: [{ brandId }, { brandIds: { has: brandId } }],
      },
      select: { id: true },
    });
    if (menuItemIds.length === 0) return { items: [] };

    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds.map((r) => r.id) } },
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

    return { ok: true };
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
        brandId: true,
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
