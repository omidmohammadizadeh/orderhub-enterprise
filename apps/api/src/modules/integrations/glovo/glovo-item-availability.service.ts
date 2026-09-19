import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { GlovoClientService } from "./glovo-client.service";
import { glovoProductIdsFor } from "./glovo-menu.transformer";

// Phase GL-4 — 86 an item on Glovo.
//
//   POST /webhook/stores/{storeId}/menu/updates
//   { products: [{ id, available }] }   → { transaction_id }  (async, ≤10 000 items)
//
// The bulk endpoint rather than PATCH /products/{id}: which product ids a
// sized item was published under depends on its modifier data at publish time
// (one tile, or one per size — see glovoProductIdsFor), so we send every
// candidate in ONE call and Glovo lists any it does not know as "not updated"
// instead of failing. A per-id PATCH would 400 on the ones that don't exist.
//
// GLOVO HAS NO TIMED 86. Unlike JET's nextAvailableAt there is nothing to say
// "back at 18:00", and OrderHub's snooze expiry is lazy (read-time) — nothing
// fires when a snooze runs out. So sweepExpired() below watches for snoozes
// that have just expired and pushes the restore itself; without it, a
// "1 hour" 86 would stay off Glovo until someone noticed.

@Injectable()
export class GlovoItemAvailabilityService {
  private readonly logger = new Logger(GlovoItemAvailabilityService.name);
  /** Snoozes that expired after this instant still need a restore push. */
  private sweptUntil = new Date(Date.now() - 10 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GlovoClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async pushItemAvailability(args: {
    tenantId: string;
    itemId: string;
    available: boolean;
    locationId?: string;
  }): Promise<{ pushed: number }> {
    if (!this.client.configured) return { pushed: 0 };
    const item = await this.prisma.menuItem.findUnique({
      where: { id: args.itemId },
      select: { id: true, name: true, brandId: true, hasMultipleSkus: true, productSkus: true },
    });
    if (!item) return { pushed: 0 };
    // MenuItem has no brand relation to filter through, so the tenant check
    // is its own query — an item id from another tenant pushes nothing.
    const owned = await this.prisma.brand.findFirst({
      where: { id: item.brandId, tenantId: args.tenantId },
      select: { id: true },
    });
    if (!owned) return { pushed: 0 };

    const targets = await this.resolveTargets(args.tenantId, args.itemId, args.locationId);
    if (targets.length === 0) return { pushed: 0 };

    const ids = glovoProductIdsFor(item);
    let pushed = 0;
    for (const t of targets) {
      // A restore must not undo a snooze that still applies at this store —
      // an ALL-channel 86 outliving a GLOVO unsnooze, or the other way round.
      if (args.available && (await this.stillSnoozed(item.id, t.locationId))) continue;
      try {
        const res = await this.client.request<{ transaction_id?: string }>(
          "POST",
          `/webhook/stores/${encodeURIComponent(t.storeId)}/menu/updates`,
          { body: { products: ids.map((id) => ({ id, available: args.available })) }, retries: 2 },
        );
        pushed++;
        this.logger.log(
          `Glovo 86 ${args.available ? "IN" : "OUT"} store ${t.storeId}: ${ids.join(",")} tx=${res?.transaction_id ?? "?"}`,
        );
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: t.brandId,
          locationId: t.locationId,
          category: "INVENTORY",
          channel: "GLOVO",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "SUCCESS",
          message: `"${item.name}" marked ${args.available ? "available" : "unavailable"} on Glovo`,
          details: { productIds: ids, storeId: t.storeId, transactionId: res?.transaction_id ?? null },
        });
      } catch (err: any) {
        this.logger.warn(`Glovo 86 failed for store ${t.storeId}: ${err?.message}`);
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: t.brandId,
          locationId: t.locationId,
          category: "INVENTORY",
          channel: "GLOVO",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "ERROR",
          message: `Glovo availability push failed for "${item.name}": ${err?.message}`,
          details: { productIds: ids, storeId: t.storeId },
        });
      }
    }
    return { pushed };
  }

  /**
   * Restore items whose timed snooze has just run out.
   *
   * Only rows that expired since the last sweep, so an item is restored once,
   * not every minute. A process restart re-covers the last ten minutes; a
   * duplicate restore is harmless.
   */
  @Cron("30 * * * * *")
  async sweepExpired(): Promise<number> {
    if (!this.client.configured) return 0;
    const from = this.sweptUntil;
    const to = new Date();
    this.sweptUntil = to;
    const rows = await (this.prisma as any).menuItemChannelAvailability
      .findMany({
        where: { channel: { in: ["GLOVO", "ALL"] }, expiresAt: { gt: from, lte: to } },
        select: { itemId: true, locationId: true, item: { select: { brandId: true } } },
        take: 500,
      })
      .catch(() => []);
    const brandIds = Array.from(new Set(rows.map((r: any) => r?.item?.brandId).filter(Boolean))) as string[];
    const brands = brandIds.length
      ? await this.prisma.brand.findMany({
          where: { id: { in: brandIds } },
          select: { id: true, tenantId: true },
        })
      : [];
    const tenantOf = new Map(brands.map((b) => [b.id, b.tenantId]));
    let restored = 0;
    for (const r of rows) {
      const tenantId = tenantOf.get(r?.item?.brandId);
      if (!tenantId) continue;
      const res = await this.pushItemAvailability({
        tenantId,
        itemId: r.itemId,
        available: true,
        ...(r.locationId ? { locationId: r.locationId } : {}),
      }).catch(() => ({ pushed: 0 }));
      restored += res.pushed;
    }
    return restored;
  }

  private async stillSnoozed(itemId: string, locationId: string): Promise<boolean> {
    const now = new Date();
    const hit = await (this.prisma as any).menuItemChannelAvailability.findFirst({
      where: {
        itemId,
        channel: { in: ["GLOVO", "ALL"] },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ locationId: null }, { locationId }] },
        ],
      },
      select: { id: true },
    });
    return !!hit;
  }

  /**
   * Every Glovo store whose LAST PUBLISHED menu contains this item, within the
   * tenant (and the location, for a location-scoped 86). The publish state on
   * the connection is authoritative: it is exactly what Glovo was sent.
   */
  private async resolveTargets(tenantId: string, itemId: string, locationId?: string) {
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "GLOVO",
        status: { not: "not_connected" },
        externalStoreId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
      select: { brandId: true, locationId: true, externalStoreId: true, metadata: true },
    });
    const out: Array<{ brandId: string; locationId: string; storeId: string }> = [];
    for (const c of conns) {
      const menuId = ((c.metadata as any) ?? {})?.glovoMenuPublish?.menuId;
      if (!menuId) continue;
      const onMenu = await this.prisma.menuCategory.findFirst({
        where: { menuId, items: { some: { itemId } } },
        select: { id: true },
      });
      if (!onMenu) continue;
      out.push({ brandId: c.brandId, locationId: c.locationId, storeId: c.externalStoreId! });
    }
    return out;
  }
}
