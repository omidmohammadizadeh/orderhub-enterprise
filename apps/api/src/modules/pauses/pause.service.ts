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
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { HubRiseLocationPauseService } from "../integrations/hubrise/hubrise-location-pause.service";
import { DeliverooConnectionService } from "../integrations/deliveroo/deliveroo-connection.service";
import { UberEatsConnectionService } from "../integrations/ubereats/ubereats-connection.service";
import { JetStoreStatusService } from "../integrations/jet/jet-store-status.service";
import { ActivityLogService } from "../logs/activity-log.service";

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
    // Phase BA-2 — mirror pauses onto the brand's DIRECT Deliveroo store,
    // exactly like the per-brand Open/Pause buttons on the channels grid.
    private readonly deliveroo: DeliverooConnectionService,
    private readonly uberEats: UberEatsConnectionService,
    // Phase JE-5 — same mirror for the brand's direct Just Eat restaurant.
    private readonly jet: JetStoreStatusService,
    @Optional() private readonly activity?: ActivityLogService,
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

    this.activity?.record({
      tenantId: args.tenantId,
      locationId: args.scope.locationId,
      brandId: args.scope.brandId ?? null,
      category: "STATUS",
      channel: args.scope.channel ?? "ALL",
      action: args.mode === "busy" ? "store.busy" : "store.pause",
      status: "WARNING",
      message:
        args.mode === "busy"
          ? `Busy mode on (+${args.extraPrepTime ?? 0} min prep)`
          : `Stopped taking orders${args.scope.channel ? ` on ${args.scope.channel}` : ""}${resumeAt ? ` until ${resumeAt.toISOString()}` : " until further notice"}`,
      details: { resumeAt, reason: args.reason ?? null },
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

    // Mirror onto the direct Deliveroo store (fire-and-forget, fully
    // swallowed — never block or fail the operator's pause on a Deliveroo
    // API hiccup). Reconcile picks up the row we just wrote.
    void this.reconcileDeliveroo(args.scope, args.tenantId);
    void this.reconcileUberEats(args.scope, args.tenantId);
    void this.reconcileJustEat(args.scope, args.tenantId);

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
      // Reopen the direct Deliveroo / Uber Eats store if nothing else keeps
      // it paused.
      void this.reconcileDeliveroo(
        { locationId: row.locationId, brandId: row.brandId, channel: row.channel },
        args.tenantId,
      );
      void this.reconcileUberEats(
        { locationId: row.locationId, brandId: row.brandId, channel: row.channel },
        args.tenantId,
      );
      void this.reconcileJustEat(
        { locationId: row.locationId, brandId: row.brandId, channel: row.channel },
        args.tenantId,
      );
      this.activity?.record({
        tenantId: args.tenantId,
        locationId: row.locationId,
        brandId: row.brandId ?? null,
        category: "STATUS",
        channel: row.channel ?? "ALL",
        action: "store.resume",
        status: "SUCCESS",
        message: `Resumed taking orders${row.channel ? ` on ${row.channel}` : ""}`,
      });
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
    void this.reconcileDeliveroo(args.scope, args.tenantId);
    void this.reconcileUberEats(args.scope, args.tenantId);
    void this.reconcileJustEat(args.scope, args.tenantId);
    this.activity?.record({
      tenantId: args.tenantId,
      locationId: args.scope.locationId,
      brandId: args.scope.brandId ?? null,
      category: "STATUS",
      channel: args.scope.channel ?? "ALL",
      action: "store.resume",
      status: "SUCCESS",
      message: `Resumed taking orders${args.scope.channel ? ` on ${args.scope.channel}` : ""}`,
    });
    return { ok: true };
  }

  /**
   * Mirror the current pause state onto the brand's DIRECT Deliveroo
   * store(s) so "Stop taking orders" closes Deliveroo — and Resume reopens
   * it — exactly like the per-brand Open/Pause buttons on the channels grid.
   *
   * Reconcile (not a blind toggle): for every connected Deliveroo store in
   * scope we recompute whether that brand's Deliveroo channel is paused and
   * push OPEN/CLOSED to match. Idempotent, and correct under overlapping
   * rows + busy mode (busy ≠ paused → the store stays open).
   *
   * Fully best-effort: any failure is logged and swallowed so a Deliveroo
   * API hiccup never breaks the operator's pause/resume.
   */
  /**
   * Mirror pauses onto connected Uber Eats stores — same reconcile model as
   * Deliveroo: for every connected UBER_EATS store in scope, recompute whether
   * that brand's Uber Eats channel is paused and push ONLINE/OFFLINE to match.
   * Best-effort; a store not yet integration-activated self-heals on the first
   * call (setStoreOnline activates + retries on the access 401).
   */
  private async reconcileUberEats(
    scope: PauseScope,
    tenantId: string,
  ): Promise<void> {
    try {
      if (scope.channel && scope.channel !== "UBER_EATS") return;
      const conns = await this.prisma.brandPlatformConnection.findMany({
        where: {
          locationId: scope.locationId,
          platform: "UBER_EATS",
          ...(scope.brandId ? { brandId: scope.brandId } : {}),
          externalStoreId: { not: null },
          status: { in: ["connected", "suspended"] },
        },
        select: { id: true, brandId: true, tenantId: true },
      });
      for (const c of conns) {
        const snap = await this.isPaused({
          locationId: scope.locationId,
          brandId: c.brandId,
          channel: "UBER_EATS",
        });
        try {
          await this.uberEats.setStoreOnline(
            c.tenantId ?? tenantId,
            c.id,
            !snap.paused,
            snap.paused ? "PAUSED_BY_RESTAURANT" : undefined,
            // Uber requires is_offline_until when going OFFLINE — use the
            // pause's real end time; open-ended pauses default inside.
            snap.paused ? snap.resumeAt : null,
          );
          this.logger.log(
            `Uber Eats store ${snap.paused ? "paused" : "resumed"} for conn ${c.id} via pause reconcile`,
          );
          this.activity?.record({
            tenantId: c.tenantId ?? tenantId,
            locationId: scope.locationId,
            brandId: c.brandId,
            category: "STATUS",
            channel: "UBER_EATS",
            action: snap.paused ? "store.pause" : "store.resume",
            status: "SUCCESS",
            message: `Uber Eats store ${snap.paused ? "paused" : "reopened"}`,
            details: { resumeAt: snap.resumeAt },
          });
        } catch (e: any) {
          this.logger.warn(
            `Uber Eats store ${snap.paused ? "pause" : "resume"} failed for conn ${c.id}: ${e?.message ?? e}`,
          );
          this.activity?.record({
            tenantId: c.tenantId ?? tenantId,
            locationId: scope.locationId,
            brandId: c.brandId,
            category: "STATUS",
            channel: "UBER_EATS",
            action: snap.paused ? "store.pause" : "store.resume",
            status: "ERROR",
            message: `Uber Eats store ${snap.paused ? "pause" : "reopen"} failed: ${e?.message ?? e}`,
          });
        }
      }
    } catch (e: any) {
      this.logger.warn(`Uber Eats pause reconcile failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Mirror our pause state onto the brand's direct Just Eat restaurant.
   *
   * Differs from the Deliveroo and Uber reconcilers in one way that matters:
   * JET's offline call accepts an `onlineAt`, so a TIMED pause restores itself
   * on their side. Passing the pause's own resumeAt means a shop that pauses
   * for an hour comes back on Just Eat by itself — where the other two rely on
   * us remembering to push the resume.
   */
  private async reconcileJustEat(
    scope: PauseScope,
    tenantId: string,
  ): Promise<void> {
    try {
      // A channel-scoped pause only touches Just Eat when it IS Just Eat.
      if (scope.channel && scope.channel !== "JUST_EAT") return;

      const conns = await this.prisma.brandPlatformConnection.findMany({
        where: {
          locationId: scope.locationId,
          platform: "JUST_EAT",
          ...(scope.brandId ? { brandId: scope.brandId } : {}),
          status: { in: ["connected", "suspended"] },
        },
        select: { id: true, brandId: true, tenantId: true },
      });

      for (const c of conns) {
        const snap = await this.isPaused({
          locationId: scope.locationId,
          brandId: c.brandId,
          channel: "JUST_EAT",
        });
        try {
          await this.jet.reconcile({
            tenantId: c.tenantId ?? tenantId,
            brandId: c.brandId,
            locationId: scope.locationId,
            paused: snap.paused,
            // Only meaningful while pausing; JET ignores it on the online call.
            until: snap.paused ? (snap.resumeAt ?? null) : null,
          });
        } catch (e: any) {
          this.logger.warn(
            `Just Eat pause reconcile failed for conn ${c.id}: ${e?.message}`,
          );
        }
      }
    } catch (e: any) {
      this.logger.warn(`Just Eat pause reconcile failed: ${e?.message}`);
    }
  }

  private async reconcileDeliveroo(
    scope: PauseScope,
    tenantId: string,
  ): Promise<void> {
    try {
      // A channel-scoped pause only touches Deliveroo when it IS Deliveroo.
      if (scope.channel && scope.channel !== "DELIVEROO") return;

      const conns = await this.prisma.brandPlatformConnection.findMany({
        where: {
          locationId: scope.locationId,
          platform: "DELIVEROO",
          ...(scope.brandId ? { brandId: scope.brandId } : {}),
          externalStoreId: { not: null },
          externalBrandId: { not: null },
          status: { in: ["connected", "suspended"] },
        },
        select: { id: true, brandId: true, tenantId: true },
      });

      for (const c of conns) {
        const snap = await this.isPaused({
          locationId: scope.locationId,
          brandId: c.brandId,
          channel: "DELIVEROO",
        });
        const shouldBeOpen = !snap.paused;
        try {
          await this.deliveroo.setStoreOpen(
            c.tenantId ?? tenantId,
            c.id,
            shouldBeOpen,
          );
          this.logger.log(
            `Deliveroo store ${shouldBeOpen ? "opened" : "closed"} for conn ${c.id} via pause reconcile`,
          );
          this.activity?.record({
            tenantId: c.tenantId ?? tenantId,
            locationId: scope.locationId,
            brandId: c.brandId,
            category: "STATUS",
            channel: "DELIVEROO",
            action: shouldBeOpen ? "store.resume" : "store.pause",
            status: "SUCCESS",
            message: `Deliveroo store ${shouldBeOpen ? "reopened" : "closed"}`,
          });
        } catch (e: any) {
          this.logger.warn(
            `Deliveroo store ${shouldBeOpen ? "open" : "close"} failed for conn ${c.id}: ${e?.message ?? e}`,
          );
          this.activity?.record({
            tenantId: c.tenantId ?? tenantId,
            locationId: scope.locationId,
            brandId: c.brandId,
            category: "STATUS",
            channel: "DELIVEROO",
            action: shouldBeOpen ? "store.resume" : "store.pause",
            status: "ERROR",
            message: `Deliveroo store ${shouldBeOpen ? "reopen" : "close"} failed: ${e?.message ?? e}`,
          });
        }
      }
    } catch (e: any) {
      this.logger.warn(`Deliveroo pause reconcile failed: ${e?.message ?? e}`);
    }
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
