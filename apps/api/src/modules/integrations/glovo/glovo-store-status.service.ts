import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { GlovoClientService } from "./glovo-client.service";

// Phase GL-5 — open / close a Glovo store.
//
//   PUT    /webhook/stores/{storeId}/closing  { until }   → 204  (close until)
//   GET    /webhook/stores/{storeId}/closing              → { until }
//   DELETE /webhook/stores/{storeId}/closing              → 204  (back to schedule)
//
// That is ALL the Store API offers. Two consequences worth stating plainly:
//
// 1. THERE IS NO INDEFINITE CLOSE. `until` is required and must be in the
//    future. An open-ended pause on our side closes Glovo for
//    GLOVO_OPEN_ENDED_CLOSE_DAYS and says so; resuming deletes the closing
//    whenever that happens.
//
// 2. OPENING HOURS CANNOT BE SET THROUGH THE API — "The regular schedule
//    itself is managed in the Glovo Partner Webapp, not through this API."
//    publishHours() refuses with that sentence rather than pretending.

export const GLOVO_OPEN_ENDED_CLOSE_DAYS = 7;

/**
 * ISO-8601 with an explicit offset and no milliseconds — the shape of the
 * spec's example ("2019-12-20T10:00:00+01:00"). Always UTC ("+00:00"): the
 * instant is what matters, and a Java OffsetDateTime parser reads it exactly.
 */
export function glovoUntil(d: Date): string {
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

@Injectable()
export class GlovoStoreStatusService {
  private readonly logger = new Logger(GlovoStoreStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GlovoClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private async connection(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "GLOVO", status: { not: "not_connected" } },
      select: { id: true, tenantId: true, brandId: true, locationId: true, externalStoreId: true },
    });
    if (!conn?.externalStoreId) throw new NotFoundException("Glovo connection not found");
    return conn as typeof conn & { externalStoreId: string };
  }

  /** Close until `until` (or the open-ended cap), or reopen. */
  async setOpen(
    tenantId: string,
    connectionId: string,
    open: boolean,
    opts: { until?: Date | null } = {},
  ) {
    const conn = await this.connection(tenantId, connectionId);
    return this.apply(conn, open, opts.until ?? null);
  }

  async getClosing(tenantId: string, connectionId: string) {
    const conn = await this.connection(tenantId, connectionId);
    const res = await this.client.request<{ until?: string } | null>(
      "GET",
      `/webhook/stores/${encodeURIComponent(conn.externalStoreId)}/closing`,
    );
    const until = res?.until ? new Date(res.until) : null;
    const closed = !!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now();
    return { closed, until: closed ? until!.toISOString() : null };
  }

  /** Mirror a ChannelPause onto every Glovo store for this brand/location. */
  async reconcile(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
    paused: boolean;
    until: Date | null;
  }): Promise<void> {
    if (!this.client.configured) return;
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId: args.tenantId,
        brandId: args.brandId,
        locationId: args.locationId,
        platform: "GLOVO",
        status: { in: ["connected", "suspended"] },
        externalStoreId: { not: null },
      },
      select: { id: true, tenantId: true, brandId: true, locationId: true, externalStoreId: true },
    });
    for (const c of conns) {
      await this.apply(c as any, !args.paused, args.until).catch((e) =>
        this.logger.warn(`Glovo pause reconcile failed for ${c.id}: ${e?.message}`),
      );
    }
  }

  async publishHours(): Promise<never> {
    throw new BadRequestException(
      "Glovo doesn't accept opening hours through its API — the regular schedule is set in the Glovo " +
        "Partner Webapp. Pausing and resuming the store from here does work.",
    );
  }

  private async apply(
    conn: { tenantId: string; brandId: string; locationId: string; externalStoreId: string },
    open: boolean,
    until: Date | null,
  ) {
    const path = `/webhook/stores/${encodeURIComponent(conn.externalStoreId)}/closing`;
    let closeUntil: Date | null = null;
    let openEnded = false;
    try {
      if (open) {
        await this.client.request("DELETE", path, { retries: 2 });
      } else {
        const now = Date.now();
        if (until && until.getTime() > now + 60_000) {
          closeUntil = until;
        } else {
          openEnded = true;
          closeUntil = new Date(now + GLOVO_OPEN_ENDED_CLOSE_DAYS * 24 * 3600_000);
        }
        await this.client.request("PUT", path, {
          body: { until: glovoUntil(closeUntil) },
          retries: 2,
        });
      }
    } catch (err: any) {
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "STATUS",
        channel: "GLOVO",
        action: open ? "store.resume" : "store.pause",
        status: "ERROR",
        message: `Could not ${open ? "reopen" : "close"} the Glovo store: ${err?.message}`,
      });
      throw err;
    }

    this.activity?.record({
      tenantId: conn.tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "STATUS",
      channel: "GLOVO",
      action: open ? "store.resume" : "store.pause",
      status: "SUCCESS",
      message: open
        ? "Glovo store reopened — back on its regular Glovo schedule"
        : openEnded
          ? `Glovo store closed. Glovo needs an end time, so it reopens by itself on ` +
            `${closeUntil!.toISOString()} unless you resume sooner`
          : `Glovo store closed until ${closeUntil!.toISOString()}`,
    });
    this.logger.log(
      `Glovo store ${conn.externalStoreId} ${open ? "OPEN" : `CLOSED until ${closeUntil!.toISOString()}`}`,
    );
    return { ok: true, open, until: closeUntil ? closeUntil.toISOString() : null, openEnded };
  }
}
