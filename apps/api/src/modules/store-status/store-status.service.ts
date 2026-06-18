import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AW-21 — Store Status overview.
//
// Read-only aggregation across the operational signals that AW-14
// (item snooze) and AW-15 (channel pause + busy mode) write. The
// goal is one place where shift managers can see "what is not
// running normally right now" without bouncing between Inventory,
// Orders board, and the storefront.
//
// All collections are filtered to active state only — a closed pause
// (resumeAt in the past) or an expired snooze does not appear. The
// service does no writes; resume/unsnooze actions stay where they
// already live (PauseService, MenuAvailabilityService).

export interface StoreStatusActor {
  id: string;
  name: string;
}

export interface PausedEntry {
  id: string;
  locationId: string;
  locationName: string;
  brandId: string | null;
  brandName: string | null;
  channel: string | null;
  reason: string | null;
  resumeAt: string | null;
  pausedAt: string;
  pausedBy: StoreStatusActor | null;
}

export interface BusyEntry extends PausedEntry {
  extraPrepTime: number | null;
}

export interface SnoozeEntry {
  id: string;
  itemId: string;
  itemName: string;
  brandId: string | null;
  brandName: string | null;
  channel: string;
  reason: string | null;
  expiresAt: string | null;
  snoozedAt: string;
  snoozedBy: StoreStatusActor | null;
}

export interface OutOfStockEntry {
  itemId: string;
  itemName: string;
  brandId: string;
  brandName: string;
  autoResumeAt: string | null;
}

export interface StoreStatusOverview {
  summary: {
    paused: number;
    busy: number;
    snoozedItems: number;
    outOfStock: number;
    issuesTotal: number;
  };
  pauses: PausedEntry[];
  busyModes: BusyEntry[];
  snoozes: SnoozeEntry[];
  outOfStock: OutOfStockEntry[];
  generatedAt: string;
}

@Injectable()
export class StoreStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param tenantId  current tenant
   * @param scopedUserId  when set, restrict to the locations this user
   *                      has been bound to via UserLocation. Pass
   *                      undefined for tenant-wide roles
   *                      (PLATFORM_ADMIN / TENANT_OWNER).
   */
  async getOverview(
    tenantId: string,
    scopedUserId?: string,
  ): Promise<StoreStatusOverview> {
    const now = new Date();

    let allowedLocationIds: string[] | null = null;
    if (scopedUserId) {
      const rows = await (this.prisma as any).userLocation.findMany({
        where: { userId: scopedUserId },
        select: { locationId: true },
      });
      allowedLocationIds = rows.map((r: any) => r.locationId);
      if (allowedLocationIds!.length === 0) {
        return this.emptyOverview(now);
      }
    }

    // Tenant filter rides on the Location's brand relation so we
    // never leak across tenants. Brand filter on items rides the
    // same way.
    const locationWhere = {
      deletedAt: null,
      brand: { tenantId },
      ...(allowedLocationIds && { id: { in: allowedLocationIds } }),
    };

    // ── 1. Active pauses + busy modes ──────────────────────────────
    const pauseRows = await (this.prisma as any).channelPause.findMany({
      where: {
        location: locationWhere,
        OR: [{ resumeAt: null }, { resumeAt: { gt: now } }],
      },
      include: {
        location: {
          select: { id: true, name: true, brand: { select: { id: true, name: true, tenantId: true } } },
        },
      },
      orderBy: { pausedAt: "desc" },
    });

    // Manual brand-lookup for the optional brandId on the row (the
    // ChannelPause schema doesn't FK-link brandId since brand is
    // optional — a pause scoped to "this location, all brands"
    // has brandId = null).
    const brandIdSet = new Set<string>();
    for (const r of pauseRows) {
      if (r.brandId) brandIdSet.add(r.brandId);
    }
    const pauseBrands: Array<{ id: string; name: string }> = brandIdSet.size
      ? await this.prisma.brand.findMany({
          where: { id: { in: Array.from(brandIdSet) }, tenantId },
          select: { id: true, name: true },
        })
      : [];
    const brandNameById = new Map<string, string>(
      pauseBrands.map((b) => [b.id, b.name] as [string, string]),
    );

    // Brands the caller can see (tenant-scoped; further narrowed by
    // user assignments). Drives both MenuItem queries below since
    // MenuItem has only a brandId FK — no relation in the schema.
    const accessibleBrands = await this.prisma.brand.findMany({
      where: {
        tenantId,
        ...(allowedLocationIds && {
          locations: { some: { id: { in: allowedLocationIds } } },
        }),
      },
      select: { id: true, name: true },
    });
    const allowedBrandIds = accessibleBrands.map((b) => b.id);
    const allBrandNameById = new Map<string, string>(
      accessibleBrands.map((b) => [b.id, b.name] as [string, string]),
    );

    // ── 2. Active item snoozes ──────────────────────────────────────
    const snoozeRows = allowedBrandIds.length
      ? await (this.prisma as any).menuItemChannelAvailability.findMany({
          where: {
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            item: { isAvailable: true, brandId: { in: allowedBrandIds } },
          },
          include: {
            item: { select: { id: true, name: true, brandId: true } },
          },
          orderBy: { snoozedAt: "desc" },
        })
      : [];

    // ── 3. Hard out-of-stock items ──────────────────────────────────
    const outOfStockRows = allowedBrandIds.length
      ? await this.prisma.menuItem.findMany({
          where: {
            outOfStock: true,
            isAvailable: true,
            brandId: { in: allowedBrandIds },
          },
          select: {
            id: true,
            name: true,
            brandId: true,
            availableRestoreAt: true,
          },
          orderBy: { updatedAt: "desc" },
        })
      : [];

    // ── 4. Resolve actor names in one query ─────────────────────────
    const actorIds = new Set<string>();
    for (const r of pauseRows) if (r.pausedBy) actorIds.add(r.pausedBy);
    for (const r of snoozeRows) if (r.snoozedBy) actorIds.add(r.snoozedBy);
    const actors: Array<{
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    }> = actorIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: Array.from(actorIds) } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const actorById = new Map<string, StoreStatusActor>(
      actors.map((u) => [
        u.id,
        {
          id: u.id,
          name: `${u.firstName} ${u.lastName}`.trim() || u.email,
        },
      ]),
    );

    const allPauses = pauseRows.map(
      (r: any): PausedEntry & { mode: string; extraPrepTime: number | null } => ({
        id: r.id,
        locationId: r.locationId,
        locationName: r.location?.name ?? "",
        brandId: r.brandId,
        brandName: r.brandId ? brandNameById.get(r.brandId) ?? null : null,
        channel: r.channel,
        reason: r.reason,
        resumeAt: r.resumeAt ? r.resumeAt.toISOString() : null,
        pausedAt: r.pausedAt.toISOString(),
        pausedBy: r.pausedBy ? actorById.get(r.pausedBy) ?? null : null,
        mode: r.mode,
        extraPrepTime: r.extraPrepTime ?? null,
      }),
    );
    const pauses: PausedEntry[] = allPauses
      .filter((p: any) => p.mode === "paused")
      .map(({ mode: _m, extraPrepTime: _e, ...rest }: any) => rest);
    const busyModes: BusyEntry[] = allPauses
      .filter((p: any) => p.mode === "busy")
      .map(({ mode: _m, ...rest }: any) => rest);

    const snoozes: SnoozeEntry[] = snoozeRows.map(
      (r: any): SnoozeEntry => ({
        id: r.id,
        itemId: r.itemId,
        itemName: r.item?.name ?? "",
        brandId: r.item?.brandId ?? null,
        brandName: r.item?.brandId
          ? allBrandNameById.get(r.item.brandId) ?? null
          : null,
        channel: r.channel,
        reason: r.snoozeReason,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        snoozedAt: r.snoozedAt.toISOString(),
        snoozedBy: r.snoozedBy ? actorById.get(r.snoozedBy) ?? null : null,
      }),
    );

    const outOfStock: OutOfStockEntry[] = outOfStockRows.map((r) => ({
      itemId: r.id,
      itemName: r.name,
      brandId: r.brandId,
      brandName: allBrandNameById.get(r.brandId) ?? "",
      autoResumeAt: r.availableRestoreAt
        ? r.availableRestoreAt.toISOString()
        : null,
    }));

    return {
      summary: {
        paused: pauses.length,
        busy: busyModes.length,
        snoozedItems: snoozes.length,
        outOfStock: outOfStock.length,
        issuesTotal:
          pauses.length + busyModes.length + snoozes.length + outOfStock.length,
      },
      pauses,
      busyModes,
      snoozes,
      outOfStock,
      generatedAt: now.toISOString(),
    };
  }

  private emptyOverview(now: Date): StoreStatusOverview {
    return {
      summary: {
        paused: 0,
        busy: 0,
        snoozedItems: 0,
        outOfStock: 0,
        issuesTotal: 0,
      },
      pauses: [],
      busyModes: [],
      snoozes: [],
      outOfStock: [],
      generatedAt: now.toISOString(),
    };
  }
}
