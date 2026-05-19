import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { BillingService } from "./billing.service";
import { UsageService } from "./usage.service";

// How many days before FREE_PILOT ends to emit an admin warning
const PILOT_WARNING_DAYS = 14;

@Injectable()
export class BillingCron {
  private readonly logger = new Logger(BillingCron.name);
  private graceRunning = false;
  private usageRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly usage: UsageService,
  ) {}

  // ── Grace period expiry — runs hourly ─────────────────────────────────────
  // Safe to run frequently: updateMany with WHERE clause is idempotent.

  @Cron("0 * * * *") // top of every hour
  async expireGracePeriods(): Promise<void> {
    if (this.graceRunning) return;
    this.graceRunning = true;
    try {
      const count = await this.billing.expireGracePeriods();
      if (count > 0) {
        this.logger.warn(
          `[GraceCron] ${count} tenant(s) moved from PAST_DUE → UNPAID after grace expiry`,
        );
        await this.auditGraceExpiryBatch(count);
      }
    } catch (err: any) {
      this.logger.error(`[GraceCron] Error: ${err.message}`, err.stack);
    } finally {
      this.graceRunning = false;
    }
  }

  // ── FREE_PILOT expiry warning — runs daily at 07:00 UTC ───────────────────
  // Emits structured warnings for pilots nearing end. Does NOT auto-convert.

  @Cron("0 7 * * *") // 07:00 UTC daily
  async warnExpiringPilots(): Promise<void> {
    const db = this.prisma as any;
    const warnBefore = new Date();
    warnBefore.setDate(warnBefore.getDate() + PILOT_WARNING_DAYS);

    try {
      const expiring = await db.tenantSubscription.findMany({
        where: {
          status: "FREE_PILOT",
          trialEndsAt: { lte: warnBefore, gte: new Date() },
        },
        select: {
          tenantId: true,
          trialEndsAt: true,
          tenant: { select: { name: true, slug: true } },
        },
      });

      if (expiring.length === 0) return;

      for (const sub of expiring) {
        const daysLeft = Math.ceil(
          (new Date(sub.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        this.logger.warn(
          `[PilotCron] FREE_PILOT expiring in ${daysLeft} days: ` +
            `tenant=${sub.tenant?.name ?? sub.tenantId} (${sub.tenantId}), ` +
            `ends=${new Date(sub.trialEndsAt).toISOString().slice(0, 10)}`,
        );
      }

      this.logger.log(
        `[PilotCron] ${expiring.length} FREE_PILOT tenant(s) expiring within ${PILOT_WARNING_DAYS} days`,
      );
    } catch (err: any) {
      this.logger.error(`[PilotCron] Error: ${err.message}`, err.stack);
    }
  }

  // ── FREE_PILOT auto-expire — runs daily at 08:00 UTC ─────────────────────
  // Moves FREE_PILOT tenants whose trialEndsAt has passed to TRIALING.
  // Does NOT auto-charge — tenant must complete Stripe checkout to become ACTIVE.

  @Cron("0 8 * * *") // 08:00 UTC daily
  async expireFreePilots(): Promise<void> {
    const db = this.prisma as any;
    const now = new Date();

    try {
      const expired = await db.tenantSubscription.findMany({
        where: {
          status: "FREE_PILOT",
          trialEndsAt: { lt: now },
        },
        select: { id: true, tenantId: true, trialEndsAt: true },
      });

      if (expired.length === 0) return;

      for (const sub of expired) {
        // Move to TRIALING — access continues but they need to complete Stripe checkout
        const trialEnd = new Date(now);
        trialEnd.setDate(trialEnd.getDate() + 30);

        await db.tenantSubscription.update({
          where: { id: sub.id },
          data: {
            status: "TRIALING",
            trialEndsAt: trialEnd,
            metadata: {
              freePilotEndedAt: now.toISOString(),
              convertedFromFreePilot: true,
            },
          },
        });

        this.logger.log(
          `[PilotCron] FREE_PILOT → TRIALING: tenant=${sub.tenantId}, ` +
            `pilotEnded=${new Date(sub.trialEndsAt).toISOString().slice(0, 10)}, ` +
            `trialEnds=${trialEnd.toISOString().slice(0, 10)}`,
        );

        await this.writeAuditLog(sub.tenantId, "billing.pilot_expired", {
          previousStatus: "FREE_PILOT",
          newStatus: "TRIALING",
          freePilotEndedAt: now.toISOString(),
          trialEndsAt: trialEnd.toISOString(),
        });
      }

      this.logger.log(
        `[PilotCron] ${expired.length} FREE_PILOT tenant(s) converted to TRIALING`,
      );
    } catch (err: any) {
      this.logger.error(`[PilotCron] Error during FREE_PILOT expiry: ${err.message}`, err.stack);
    }
  }

  // ── Monthly usage aggregation — runs daily at 02:00 UTC ──────────────────
  // Safe to run daily — upserts are idempotent.
  // Only aggregates for tenants with an active subscription.

  @Cron("0 2 * * *") // 02:00 UTC daily
  async aggregateUsage(): Promise<void> {
    if (this.usageRunning) return;
    this.usageRunning = true;

    const dryRun = process.env.USAGE_CRON_DRY_RUN === "true";

    try {
      const db = this.prisma as any;

      // Find all active locations with a subscription
      const activeLocations = await db.location.findMany({
        where: {
          deletedAt: null,
          isPaused: false,
          brand: {
            tenant: {
              subscription: {
                status: { in: ["TRIALING", "ACTIVE", "FREE_PILOT", "PAST_DUE"] },
              },
            },
          },
        },
        select: {
          id: true,
          brand: {
            select: {
              tenant: {
                select: {
                  id: true,
                  subscription: { select: { id: true } },
                },
              },
            },
          },
        },
      });

      if (dryRun) {
        this.logger.log(
          `[UsageCron] DRY RUN — would aggregate ${activeLocations.length} location(s)`,
        );
        return;
      }

      let processed = 0;
      let errors = 0;

      for (const loc of activeLocations) {
        const tenantId = loc.brand?.tenant?.id;
        if (!tenantId) continue;

        try {
          await this.usage.aggregateMonthlyUsage(tenantId, loc.id);
          processed++;
        } catch (err: any) {
          this.logger.warn(
            `[UsageCron] Failed to aggregate ${tenantId}/${loc.id}: ${err.message}`,
          );
          errors++;
        }
      }

      this.logger.log(
        `[UsageCron] Aggregated ${processed} location(s) (${errors} errors)`,
      );
    } catch (err: any) {
      this.logger.error(`[UsageCron] Error: ${err.message}`, err.stack);
    } finally {
      this.usageRunning = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async auditGraceExpiryBatch(count: number): Promise<void> {
    // System-level audit entry — no tenantId since it's a batch operation
    // Individual tenant audit entries would require per-tenant queries here.
    // For now, log as a system event (full per-tenant audit in Phase T if needed).
    this.logger.log(
      `[GraceCron] Audit: ${count} tenants expired to UNPAID at ${new Date().toISOString()}`,
    );
  }

  private async writeAuditLog(
    tenantId: string,
    event: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          event,
          resource: "subscription",
          meta: meta as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(`[BillingCron] Failed to write audit log: ${err.message}`);
    }
  }

  // ── Stats (for health endpoint and tests) ─────────────────────────────────

  async getStats(): Promise<{
    pastDueCount: number;
    unpaidCount: number;
    freePilotCount: number;
    freePilotExpiringWithin14Days: number;
    trialingCount: number;
    activeCount: number;
  }> {
    const db = this.prisma as any;
    const warnBefore = new Date();
    warnBefore.setDate(warnBefore.getDate() + PILOT_WARNING_DAYS);

    const [pastDue, unpaid, freePilot, expiringPilots, trialing, active] = await Promise.all([
      db.tenantSubscription.count({ where: { status: "PAST_DUE" } }),
      db.tenantSubscription.count({ where: { status: "UNPAID" } }),
      db.tenantSubscription.count({ where: { status: "FREE_PILOT" } }),
      db.tenantSubscription.count({
        where: { status: "FREE_PILOT", trialEndsAt: { lte: warnBefore, gte: new Date() } },
      }),
      db.tenantSubscription.count({ where: { status: "TRIALING" } }),
      db.tenantSubscription.count({ where: { status: "ACTIVE" } }),
    ]);

    return {
      pastDueCount: pastDue,
      unpaidCount: unpaid,
      freePilotCount: freePilot,
      freePilotExpiringWithin14Days: expiringPilots,
      trialingCount: trialing,
      activeCount: active,
    };
  }
}
