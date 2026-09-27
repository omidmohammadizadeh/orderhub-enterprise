import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";
import { kInt } from "./keeta-json";

// Phase KT-4 — 86 an item on Keeta.
//
//   POST /product/spustatus/batchupdatebycode
//        { shopId, spuOpenItemCodeList: [our MenuItem.id], status: 0|1, needLinkage: 0 }
//
// By SPU code, which is our MenuItem id — that covers every size of the item
// at once. needLinkage 0: we do not want Keeta also flipping an option that
// happens to share the item's name (their auto-binding), because our own
// options have their own availability.
//
// Keeta have NO TIMED 86, and our snooze expiry is lazy (read-time), so a
// "back in an hour" 86 would stay off Keeta for good. sweepExpired pushes the
// restore when the snooze runs out — the same answer Glovo needed.

@Injectable()
export class KeetaItemAvailabilityService {
  private readonly logger = new Logger(KeetaItemAvailabilityService.name);
  private sweptUntil = new Date(Date.now() - 10 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
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
      select: { id: true, name: true, brandId: true },
    });
    if (!item) return { pushed: 0 };
    const owned = await this.prisma.brand.findFirst({
      where: { id: item.brandId, tenantId: args.tenantId },
      select: { id: true },
    });
    if (!owned) return { pushed: 0 };

    const targets = await this.resolveTargets(args.tenantId, args.itemId, args.locationId);
    let pushed = 0;
    for (const t of targets) {
      if (args.available && (await this.stillSnoozed(item.id, t.locationId))) continue;
      try {
        const token = await this.auth.tokenForConnection(t);
        await this.client.request(
          "/product/spustatus/batchupdatebycode",
          {
            shopId: kInt(t.externalStoreId),
            spuOpenItemCodeList: [item.id],
            status: args.available ? 1 : 0,
            needLinkage: 0,
          },
          { accessToken: token, retries: 1 },
        );
        pushed++;
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: t.brandId,
          locationId: t.locationId,
          category: "INVENTORY",
          channel: "KEETA",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "SUCCESS",
          message: `"${item.name}" marked ${args.available ? "available" : "unavailable"} on Keeta`,
        });
      } catch (err: any) {
        this.logger.warn(`Keeta 86 failed for shop ${t.externalStoreId}: ${err?.message}`);
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: t.brandId,
          locationId: t.locationId,
          category: "INVENTORY",
          channel: "KEETA",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "ERROR",
          message: `Keeta availability push failed for "${item.name}": ${err?.message}`,
        });
      }
    }
    return { pushed };
  }

  @Cron("45 * * * * *")
  async sweepExpired(): Promise<number> {
    if (!this.client.configured) return 0;
    const from = this.sweptUntil;
    const to = new Date();
    this.sweptUntil = to;
    const rows = await (this.prisma as any).menuItemChannelAvailability
      .findMany({
        where: { channel: { in: ["KEETA", "ALL"] }, expiresAt: { gt: from, lte: to } },
        select: { itemId: true, locationId: true, item: { select: { brandId: true } } },
        take: 500,
      })
      .catch(() => []);
    if (!rows.length) return 0;
    const brandIds = Array.from(new Set(rows.map((r: any) => r?.item?.brandId).filter(Boolean))) as string[];
    const brands = await this.prisma.brand.findMany({
      where: { id: { in: brandIds } },
      select: { id: true, tenantId: true },
    });
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
        channel: { in: ["KEETA", "ALL"] },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ locationId: null }, { locationId }] },
        ],
      },
      select: { id: true },
    });
    return !!hit;
  }

  /** Every Keeta store whose LAST published menu contains this item. */
  private async resolveTargets(tenantId: string, itemId: string, locationId?: string) {
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "KEETA",
        status: { in: ["connected", "suspended"] },
        externalStoreId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
      select: { brandId: true, locationId: true, externalStoreId: true, metadata: true },
    });
    const out: Array<{ brandId: string; locationId: string; externalStoreId: string; metadata: unknown }> = [];
    for (const c of conns) {
      const menuId = ((c.metadata as any) ?? {})?.keetaMenuPublish?.menuId;
      if (!menuId) continue;
      const onMenu = await this.prisma.menuCategory.findFirst({
        where: { menuId, items: { some: { itemId } } },
        select: { id: true },
      });
      if (!onMenu) continue;
      out.push({ ...c, externalStoreId: c.externalStoreId! });
    }
    return out;
  }
}
