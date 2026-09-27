// Phase BK — the Yango poller: the source of truth for courier progress.
//
// Why poll at all: Yango's callback_url is marked DEPRECATED in its own docs,
// carries only claim_id (no state), is unsigned, and gives up after a few
// undocumented retries. The docs point to claims/journal + claims/bulk_info
// instead. We use bulk_info over the orders we know are in flight — one call
// per location per tick, up to 1000 claims each, with no cursor state to lose.
//
// It is also how accepting survives a slow estimate: dispatch waits ~12s for
// `ready_for_approval`; anything slower is accepted (or refused) here.
//
// DELIBERATE LIMITS — this runs against real couriers and real money:
//  - Only orders with courierProvider=YANGO and a claim id, not in a terminal
//    status, dispatched in the last 24h.
//  - Leaves a just-created claim to the dispatch call for its first 20s, rather
//    than racing it to the accept.
//  - YANGO_POLL_ENABLED=false stops it without a deploy.

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { YangoClientService } from "./yango-client.service";
import { YangoConfigService } from "./yango-config.service";
import { YangoTrackingService } from "./yango-tracking.service";
import { YANGO_TERMINAL } from "./yango-status";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DISPATCH_GRACE_MS = 20_000;

@Injectable()
export class YangoPollCron {
  private readonly logger = new Logger(YangoPollCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: YangoClientService,
    private readonly config: YangoConfigService,
    private readonly tracking: YangoTrackingService,
  ) {}

  @Cron("*/15 * * * * *")
  async tick() {
    if (process.env.YANGO_POLL_ENABLED === "false") return;
    if (this.running) return;
    this.running = true;
    try {
      await this.pollOnce();
    } catch (err: any) {
      this.logger.error(`Yango poll failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  async pollOnce(now = Date.now()): Promise<{ polled: number; applied: number }> {
    const terminalUpper = [...YANGO_TERMINAL].map((s) => s.toUpperCase());
    const orders: any[] = await (this.prisma as any).order.findMany({
      where: {
        courierProvider: "YANGO",
        courierJobId: { not: null },
        createdAt: { gte: new Date(now - MAX_AGE_MS) },
        OR: [{ courierStatus: null }, { courierStatus: { notIn: terminalUpper } }],
      },
      take: 2000,
    });
    if (!orders.length) return { polled: 0, applied: 0 };

    const byLocation = new Map<string, any[]>();
    for (const o of orders) {
      const meta = ((o.metadata ?? {}) as any).yango ?? {};
      const t = meta.dispatchedAt ? new Date(meta.dispatchedAt).getTime() : 0;
      if (meta.acceptPending && Number.isFinite(t) && now - t < DISPATCH_GRACE_MS) continue;
      const list = byLocation.get(o.locationId) ?? [];
      list.push(o);
      byLocation.set(o.locationId, list);
    }

    let applied = 0;
    for (const [locationId, list] of byLocation) {
      const cfg = await this.config.getDecrypted(locationId);
      if (!cfg?.token) continue;
      let claims;
      try {
        claims = await this.client.bulkInfo(cfg, list.map((o) => o.courierJobId));
      } catch (err: any) {
        this.logger.warn(`Yango bulk_info for location ${locationId} failed: ${err?.message ?? err}`);
        continue;
      }
      const byId = new Map(claims.map((c) => [c.id, c]));
      for (const order of list) {
        const claim = byId.get(order.courierJobId);
        if (!claim) continue;
        try {
          await this.tracking.apply(order, claim, cfg);
          applied++;
        } catch (err: any) {
          this.logger.warn(`Yango apply for order ${order.id} failed: ${err?.message ?? err}`);
        }
      }
    }
    return { polled: orders.length, applied };
  }
}
