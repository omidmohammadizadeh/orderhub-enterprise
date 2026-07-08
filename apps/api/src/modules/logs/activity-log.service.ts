import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase LG — operator-facing activity feed (the dashboard "Logs" page).
//
// Every meaningful integration/system action records one readable row:
//   MENU      menu publishes per channel (success/failure + counts)
//   ORDERS    order received / accepted / denied / ready / cancelled pushes
//   INVENTORY stock + availability (86) changes
//   STATUS    store pauses/resumes per channel
//   CONNECTION channel connect/disconnect/link events
//
// record() is strictly best-effort and NEVER throws — a logging failure must
// never break the action being logged. Services either inject this (marked
// @Optional() so manually-constructed unit tests keep working) or emit an
// "activity.log" event if they already carry an EventEmitter2.

export type ActivityCategory =
  | "MENU"
  | "ORDERS"
  | "INVENTORY"
  | "STATUS"
  | "PAYMENTS"
  | "PRINTING"
  | "CONNECTION";

export type ActivityStatus = "SUCCESS" | "ERROR" | "INFO" | "WARNING";

export interface ActivityEntry {
  tenantId: string;
  locationId?: string | null;
  brandId?: string | null;
  category: ActivityCategory;
  channel?: string | null; // UBER_EATS | DELIVEROO | HUBRISE | DIRECT | SYSTEM…
  action: string; // e.g. "menu.publish", "order.accept", "store.pause"
  status: ActivityStatus;
  message: string;
  details?: Record<string, unknown>;
}

const MAX_DETAILS_CHARS = 4_000; // keep rows light; details are a debugging aid
const RETENTION_DAYS = 30; // feed is operational, not an archive — purge daily

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget write. Never throws, never blocks the caller's flow. */
  record(entry: ActivityEntry): void {
    void this.write(entry);
  }

  /** Emit-based variant for services that already carry an EventEmitter2. */
  @OnEvent("activity.log")
  onActivityEvent(entry: ActivityEntry): void {
    this.record(entry);
  }

  private async write(entry: ActivityEntry): Promise<void> {
    try {
      let details = entry.details ?? {};
      // Guard against giant payloads (menu bodies etc.) bloating the table.
      const raw = JSON.stringify(details);
      if (raw.length > MAX_DETAILS_CHARS) {
        details = { truncated: true, preview: raw.slice(0, MAX_DETAILS_CHARS) };
      }
      await (this.prisma as any).activityLog.create({
        data: {
          tenantId: entry.tenantId,
          locationId: entry.locationId ?? null,
          brandId: entry.brandId ?? null,
          category: entry.category,
          channel: entry.channel ?? null,
          action: entry.action,
          status: entry.status,
          message: entry.message.slice(0, 500),
          details: details as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `activity log write failed (${entry.category}/${entry.action}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Daily retention purge (04:40, before the 5am order auto-complete).
   * Keeps the table + indexes small forever; the feed is an operational
   * timeline, not an audit archive (AuditLog serves that purpose).
   */
  @Cron("40 4 * * *")
  async purgeOldEntries(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
      const res = await (this.prisma as any).activityLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (res.count > 0) {
        this.logger.log(
          `activity log retention: purged ${res.count} rows older than ${RETENTION_DAYS}d`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`activity log purge failed: ${err?.message ?? err}`);
    }
  }

  /** Cursor-paginated feed for the dashboard Logs page. */
  // Locations a user may see logs for: tenant-wide admins see all (null =
  // no constraint); everyone else is limited to their UserLocation ∪ their
  // brands' locations. Mirrors the app-wide scoping.
  private async accessibleLocationIds(user: {
    userId: string;
    tenantId: string;
    role: string;
  }): Promise<string[] | null> {
    if (["PLATFORM_ADMIN", "TENANT_OWNER"].includes(user.role)) return null;
    const [locRows, brandRows] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId: user.userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId: user.userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locRows.map((r: any) => r.locationId));
    const brandIds: string[] = brandRows.map((r: any) => r.brandId);
    if (brandIds.length) {
      const brands = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId: user.tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brands) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  async list(
    user: { userId: string; tenantId: string; role: string },
    opts: {
      category?: string;
      channel?: string;
      locationId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // Scope to the locations this user can see. A requested locationId only
    // narrows within that set; one outside it yields nothing.
    const allowed = await this.accessibleLocationIds(user);
    if (allowed !== null && allowed.length === 0) {
      return { entries: [], nextCursor: null };
    }
    let locationFilter: any = undefined;
    if (opts.locationId) {
      if (allowed !== null && !allowed.includes(opts.locationId)) {
        return { entries: [], nextCursor: null };
      }
      locationFilter = opts.locationId;
    } else if (allowed !== null) {
      locationFilter = { in: allowed };
    }
    const rows = await (this.prisma as any).activityLog.findMany({
      where: {
        tenantId: user.tenantId,
        ...(opts.category ? { category: opts.category } : {}),
        // Comma-separated channel list — the UI's "Online ordering" filter
        // covers both ONLINE and DIRECT platform tags with one selection.
        ...(opts.channel
          ? { channel: { in: opts.channel.split(",").filter(Boolean) } }
          : {}),
        ...(locationFilter !== undefined ? { locationId: locationFilter } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Resolve brand names in one query so the UI can show them without joins.
    const brandIds = [
      ...new Set(page.map((r: any) => r.brandId).filter(Boolean)),
    ] as string[];
    const brands = brandIds.length
      ? await this.prisma.brand.findMany({
          where: { id: { in: brandIds } },
          select: { id: true, name: true },
        })
      : [];
    const brandName = new Map(
      brands.map((b: { id: string; name: string }) => [b.id, b.name] as const),
    );
    return {
      entries: page.map((r: any) => ({
        id: r.id,
        category: r.category,
        channel: r.channel,
        action: r.action,
        status: r.status,
        message: r.message,
        details: r.details,
        locationId: r.locationId,
        brandId: r.brandId,
        brandName: r.brandId ? (brandName.get(r.brandId) ?? null) : null,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }
}
