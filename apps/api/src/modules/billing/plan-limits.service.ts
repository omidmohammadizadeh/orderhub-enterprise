import {
  Injectable,
  Logger,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Statuses that bypass plan limits entirely (not yet commercially enforced).
// FREE_PILOT shops are protected from limit enforcement until their pilot ends.
const LIMIT_BYPASS_STATUSES = new Set(["FREE_PILOT", "TRIALING"]);
// Statuses that produce a warning but don't hard-block existing resources.
const WARN_STATUSES = new Set(["PAST_DUE"]);

export interface PlanContext {
  status: string;
  maxLocations: number | null;
  maxUsers: number | null;
  features: string[];
  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  planName: string;
}

@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);
  private readonly db: any;

  constructor(private readonly prisma: PrismaService) {
    this.db = prisma as any;
  }

  // ── Plan context ───────────────────────────────────────────────────────────

  async getPlanContext(tenantId: string): Promise<PlanContext | null> {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        plan: {
          select: {
            name: true,
            maxLocations: true,
            maxUsers: true,
            features: true,
          },
        },
      },
    });

    if (!sub) return null;

    return {
      status: sub.status,
      maxLocations: sub.plan?.maxLocations ?? null,
      maxUsers: sub.plan?.maxUsers ?? null,
      features: (sub.plan?.features as string[]) ?? [],
      trialEndsAt: sub.trialEndsAt ?? null,
      gracePeriodEndsAt: sub.gracePeriodEndsAt ?? null,
      planName: sub.plan?.name ?? "UNKNOWN",
    };
  }

  // ── Location limit ─────────────────────────────────────────────────────────

  async assertLocationLimit(tenantId: string): Promise<void> {
    const ctx = await this.getPlanContext(tenantId);
    if (!ctx) return; // no subscription — allow (pre-billing)
    if (LIMIT_BYPASS_STATUSES.has(ctx.status)) return;
    if (ctx.maxLocations === null) return; // unlimited

    const currentCount = await this.db.location.count({
      where: {
        brand: { tenantId },
        deletedAt: null,
      },
    });

    if (currentCount >= ctx.maxLocations) {
      throw new ForbiddenException(
        `Your ${ctx.planName} plan allows up to ${ctx.maxLocations} location(s). ` +
          `You currently have ${currentCount}. Upgrade your plan to add more locations.`,
      );
    }

    if (WARN_STATUSES.has(ctx.status)) {
      this.logger.warn(
        `Tenant ${tenantId} is ${ctx.status} but within location limit (${currentCount}/${ctx.maxLocations})`,
      );
    }
  }

  // ── User limit ─────────────────────────────────────────────────────────────

  async assertUserLimit(tenantId: string): Promise<void> {
    const ctx = await this.getPlanContext(tenantId);
    if (!ctx) return;
    if (LIMIT_BYPASS_STATUSES.has(ctx.status)) return;
    if (ctx.maxUsers === null) return;

    const currentCount = await this.prisma.user.count({
      where: { tenantId, isActive: true },
    });

    if (currentCount >= ctx.maxUsers) {
      throw new ForbiddenException(
        `Your ${ctx.planName} plan allows up to ${ctx.maxUsers} active users. ` +
          `You currently have ${currentCount}. Upgrade your plan to add more staff.`,
      );
    }
  }

  // ── Feature flag ───────────────────────────────────────────────────────────

  async assertFeature(tenantId: string, featureKey: string): Promise<void> {
    const ctx = await this.getPlanContext(tenantId);
    if (!ctx) return; // no subscription — allow
    if (LIMIT_BYPASS_STATUSES.has(ctx.status)) return; // FREE_PILOT/TRIALING bypass
    if (ctx.features.includes(featureKey)) return;

    throw new ForbiddenException(
      `The '${featureKey}' feature is not included in your ${ctx.planName} plan. ` +
        `Upgrade to access this feature.`,
    );
  }

  async hasFeature(tenantId: string, featureKey: string): Promise<boolean> {
    const ctx = await this.getPlanContext(tenantId);
    if (!ctx) return true; // no subscription — allow
    if (LIMIT_BYPASS_STATUSES.has(ctx.status)) return true;
    return ctx.features.includes(featureKey);
  }

  // ── Billing warnings (for UI banners) ─────────────────────────────────────

  async getBillingWarnings(tenantId: string): Promise<string[]> {
    const ctx = await this.getPlanContext(tenantId);
    if (!ctx) return [];

    const warnings: string[] = [];
    const now = new Date();

    if (ctx.status === "FREE_PILOT" && ctx.trialEndsAt) {
      const daysLeft = Math.ceil(
        (ctx.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysLeft <= 14) {
        warnings.push(
          daysLeft <= 0
            ? `Your free pilot has ended. Please complete subscription setup to continue access.`
            : `Your free pilot ends in ${daysLeft} day(s) on ${ctx.trialEndsAt.toISOString().slice(0, 10)}.`,
        );
      }
    }

    if (ctx.status === "TRIALING" && ctx.trialEndsAt) {
      const daysLeft = Math.ceil(
        (ctx.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysLeft <= 7) {
        warnings.push(
          daysLeft <= 0
            ? `Your trial has ended. Please add a payment method to continue.`
            : `Your trial ends in ${daysLeft} day(s). Add a payment method to avoid interruption.`,
        );
      }
    }

    if (ctx.status === "PAST_DUE") {
      if (ctx.gracePeriodEndsAt) {
        const daysLeft = Math.ceil(
          (ctx.gracePeriodEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );
        warnings.push(
          daysLeft <= 0
            ? `Payment overdue and grace period has expired. Access is restricted.`
            : `Payment overdue. Update your payment method within ${daysLeft} day(s) to avoid access restriction.`,
        );
      } else {
        warnings.push("Payment overdue. Please update your payment method.");
      }
    }

    if (ctx.status === "UNPAID") {
      warnings.push(
        "Your subscription is unpaid and access is restricted. " +
          "Please update your payment method immediately or contact support.",
      );
    }

    if (ctx.status === "CANCELLED") {
      warnings.push(
        "Your subscription has been cancelled. Contact support to reactivate.",
      );
    }

    return warnings;
  }
}
