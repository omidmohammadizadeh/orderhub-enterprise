// Phase AW-15 — Stop Taking Orders + Busy Mode.
//
// One service runs every pause / busy / resume across the four scope
// granularities (location / brand / channel / brand+channel). Storefront,
// POS, and the HubRise sync all read isPaused() at check time — no
// cron needed because every row carries its own resumeAt.

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { HubRiseLocationPauseService } from "../integrations/hubrise/hubrise-location-pause.service";

export type SupportedChannel =
  | "ONLINE"
  | "POS"
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "WHATSAPP"
  | "HUBRISE";

export type DurationPreset =
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "12h"
  | "until_tomorrow"
  | "until_further_notice";

export type Mode = "paused" | "busy";

export interface PauseScope {
  locationId: string;
  brandId?: string | null;
  channel?: SupportedChannel | null;
}

export interface PauseSnapshot {
  paused: boolean;
  mode: Mode | null;
  brandName?: string | null;
  resumeAt: Date | null;
  reason: string | null;
  extraPrepTime: number | null;
  /** The actual row that matched, if any (most specific wins). */
  matchedRow?: any;
}

@Injectable()
export class PauseService {
  private readonly logger = new Logger(PauseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => HubRiseLocationPauseService))
    private readonly hubrise: HubRiseLocationPauseService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────

  /**
   * Is this (location, brand, channel) currently paused? Walks all four
   * possible scope rows and returns the most specific match. If none
   * are active (or all matching rows have resumeAt in the past),
   * returns { paused: false }.
   */
  async isPaused(scope: PauseScope): Promise<PauseSnapshot> {
    const now = new Date();
    const rows = await (this.prisma as any).channelPause.findMany({
      where: {
        locationId: scope.locationId,
        OR: [{ resumeAt: null }, { resumeAt: { gt: now } }],
        AND: [
          {
            OR: [
              { brandId: null },
              ...(scope.brandId ? [{ brandId: scope.brandId }] : []),
            ],
          },
          {
            OR: [
              { channel: null },
              ...(scope.channel ? [{ channel: scope.channel }] : []),
            ],
          },
        ],
      },
      orderBy: { pausedAt: "desc" },
    });
    if (rows.length === 0) {
      return {
        paused: false,
        mode: null,
        resumeAt: null,
        reason: null,
        extraPrepTime: null,
      };
    }
    // Pick the row with the most specific match — exact brand+channel
    // beats brand-only beats channel-only beats location-only.
    const specificity = (r: any) =>
      (r.brandId ? 2 : 0) + (r.channel ? 1 : 0);
    const winner = [...rows].sort(
      (a, b) => specificity(b) - specificity(a),
    )[0];

    let brandName: string | null = null;
    if (winner.brandId) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: winner.brandId },
        select: { name: true },
      });
      brandName = brand?.name ?? null;
    }

    return {
      paused: winner.mode === "paused",
      mode: winner.mode as Mode,
      brandName,
      resumeAt: winner.resumeAt,
      reason: winner.reason,
      extraPrepTime: winner.extraPrepTime ?? null,
      matchedRow: winner,
    };
  }

  /**
   * Inventory-board style payload: every active pause row at a location.
   * Returns the rows so the operator UI can show a "currently paused"
   * panel + a one-click Resume per scope.
   */
  async listActiveForLocation(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    const now = new Date();
    return (this.prisma as any).channelPause.findMany({
      where: {
        locationId,
        OR: [{ resumeAt: null }, { resumeAt: { gt: now } }],
      },
      orderBy: { pausedAt: "desc" },
    });
  }

  // ─── Writes ────────────────────────────────────────────────────────

  /**
   * Create a pause row. Use mode="paused" to stop accepting orders;
   * mode="busy" to keep accepting but bolt extra prep time on.
   * Calling this with the same scope just creates a new row — the
   * specificity walk in isPaused() picks the latest match.
   */
  async pause(args: {
    tenantId: string;
    userId?: string;
    scope: PauseScope;
    mode: Mode;
    duration?: DurationPreset;
    customResumeAt?: string;
    reason?: string;
    /** Required when mode = "busy". */
    extraPrepTime?: number;
  }) {
    await this.assertLocationAccess(args.scope.locationId, args.tenantId);
    if (args.scope.brandId) {
      await this.assertBrandAtLocation(
        args.scope.locationId,
        args.scope.brandId,
      );
    }
    if (args.mode === "busy" && !args.extraPrepTime) {
      throw new BadRequestException(
        "extraPrepTime is required for busy mode",
      );
    }

    const resumeAt = this.resolveResumeAt(args.duration, args.customResumeAt);

    const row = await (this.prisma as any).channelPause.create({
      data: {
        locationId: args.scope.locationId,
        brandId: args.scope.brandId ?? null,
        channel: args.scope.channel ?? null,
        mode: args.mode,
        resumeAt,
        // Busy mode doesn't surface a reason to the customer — match
        // HubRise behaviour and skip persisting it locally too.
        reason: args.mode === "busy" ? null : args.reason ?? null,
        extraPrepTime: args.mode === "busy" ? args.extraPrepTime ?? null : null,
        pausedBy: args.userId ?? null,
      },
    });

    // HubRise sync: only when the scope hits the whole HubRise channel
    // (or a location-wide pause). HubRise's PATCH /locations is
    // location-wide only — so per-brand-only pauses skip the sync.
    if (
      !args.scope.brandId ||
      args.scope.channel === "HUBRISE" ||
      !args.scope.channel
    ) {
      this.hubrise
        .syncFromPause({
          locationId: args.scope.locationId,
          mode: args.mode,
          resumeAt,
          reason: args.reason ?? null,
          extraPrepTime: args.extraPrepTime ?? null,
        })
        .catch((err) =>
          this.logger.warn(
            `HubRise location pause sync failed: ${err?.message ?? err}`,
          ),
        );
    }

    return row;
  }

  /**
   * Resume one specific pause row (by id) or every row matching a
   * scope. Pass a row id when the operator clicks "Resume" next to a
   * specific entry; pass a scope when they hit a global resume.
   */
  async resume(args: {
    tenantId: string;
    rowId?: string;
    scope?: PauseScope;
  }) {
    if (args.rowId) {
      const row = await (this.prisma as any).channelPause.findUnique({
        where: { id: args.rowId },
      });
      if (!row) throw new NotFoundException("Pause not found");
      await this.assertLocationAccess(row.locationId, args.tenantId);
      await (this.prisma as any).channelPause.delete({ where: { id: row.id } });
      // After resuming, push current state to HubRise. If no other
      // location-wide rows remain, the location goes back to normal.
      const remaining = await this.isPaused({ locationId: row.locationId });
      this.hubrise
        .syncFromPause({
          locationId: row.locationId,
          mode: remaining.paused ? remaining.mode! : "normal",
          resumeAt: remaining.resumeAt,
          reason: remaining.reason,
          extraPrepTime: remaining.extraPrepTime,
        })
        .catch((err) =>
          this.logger.warn(
            `HubRise resume sync failed: ${err?.message ?? err}`,
          ),
        );
      return { ok: true };
    }
    if (!args.scope) throw new BadRequestException("rowId or scope required");
    await this.assertLocationAccess(args.scope.locationId, args.tenantId);
    await (this.prisma as any).channelPause.deleteMany({
      where: {
        locationId: args.scope.locationId,
        brandId: args.scope.brandId ?? undefined,
        channel: args.scope.channel ?? undefined,
      },
    });
    return { ok: true };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async assertLocationAccess(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  private async assertBrandAtLocation(locationId: string, brandId: string) {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { brandId: true },
    });
    // A brand "at" a location is either the location's primary brand
    // or a virtual brand whose primaryLocationId === this location.
    if (location?.brandId === brandId) return;
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { primaryLocationId: true },
    });
    if (brand?.primaryLocationId === locationId) return;
    throw new BadRequestException("Brand does not operate at this location");
  }

  private resolveResumeAt(
    duration?: DurationPreset,
    customResumeAt?: string,
  ): Date | null {
    if (customResumeAt) {
      const d = new Date(customResumeAt);
      if (isNaN(d.getTime())) throw new BadRequestException("Invalid customResumeAt");
      return d;
    }
    if (!duration) return null;
    if (duration === "until_further_notice") return null;
    if (duration === "until_tomorrow") {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      return t;
    }
    const hours: Record<string, number> = {
      "1h": 1,
      "2h": 2,
      "4h": 4,
      "6h": 6,
      "12h": 12,
    };
    const h = hours[duration];
    if (!h) throw new BadRequestException(`Unknown duration: ${duration}`);
    return new Date(Date.now() + h * 60 * 60 * 1000);
  }
}
