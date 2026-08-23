import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

export const BILLING_EXEMPT_KEY = "billingExempt";

// Mark a route as exempt from billing checks (e.g. order endpoints, printer endpoints).
// IMPORTANT: order ingestion and printer polling must NEVER be gated by billing status.
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT_KEY, true);

// ── Two subscription systems, one guard ─────────────────────────────────────
//
// TenantSubscription (modules/billing, /dashboard/billing) is the Phase F
// system this guard was written against. MerchantSubscription
// (modules/subscriptions, /dashboard/subscription) superseded it in June, is
// the only one in the sidebar, and is what actually charges merchants — but
// nothing read it, so a merchant whose card failed kept full access for ever.
//
// The guard now reads both. A tenant is in good standing if EITHER system says
// so, which is deliberately generous: with two sources of truth, the failure
// that matters is locking out a paying shop, not admitting an unpaying one for
// another day.
//
// ── Why this ships switched off ─────────────────────────────────────────────
//
// Turning enforcement on for a system nothing has ever enforced can lock a
// live restaurant out of its till mid-service. So `BILLING_ENFORCEMENT`
// defaults to `observe`: the guard works out what it WOULD have done and logs
// it, and lets the request through. Watch the logs, see who would be affected,
// then set it to `enforce`. `off` disables the merchant-side check entirely
// and restores the old behaviour exactly.
type EnforcementMode = "off" | "observe" | "enforce";

function enforcementMode(): EnforcementMode {
  const raw = String(process.env.BILLING_ENFORCEMENT ?? "observe").toLowerCase();
  return raw === "enforce" || raw === "off" ? raw : "observe";
}

/** Statuses on the TENANT-level system that permit access. */
const ACTIVE_STATUSES = new Set([
  "TRIALING",
  "ACTIVE",
  "FREE_PILOT",
  "PAST_DUE", // allowed during grace period — see below
]);

/** Stripe's own vocabulary, lowercase, on MerchantSubscription.
 *
 *  `past_due` is here on purpose: Stripe is still retrying the card, and
 *  cutting a shop off while its own dunning is mid-flight would beat Stripe to
 *  a conclusion it hasn't reached. `unpaid` is where Stripe gives up, and
 *  that's where we do too. */
const MERCHANT_OK_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "incomplete", // card not entered yet — they're mid-signup, not delinquent
]);

/** How long after Stripe gives up before access actually stops. Stripe's smart
 *  retries run about two weeks; this is the cushion after that, so nobody
 *  loses their till the same morning a card expires. */
const MERCHANT_GRACE_DAYS = 7;

@Injectable()
export class BillingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  private readonly logger = new Logger(BillingGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isExempt = this.reflector.getAllAndOverride<boolean>(
      BILLING_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isExempt) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user) return true; // JWT guard hasn't run yet — let it handle auth
    if (user.role === "PLATFORM_ADMIN") return true; // admin always allowed

    const sub = await (this.prisma as any).tenantSubscription.findUnique({
      where: { tenantId: user.tenantId },
      select: { status: true, gracePeriodEndsAt: true },
    });

    // No tenant-level row is the common case now — the newer per-location
    // system doesn't write one. Fall through to it rather than waving the
    // request past, which is what left billing unenforced.
    if (!sub) return this.checkMerchantSubscriptions(user, request);

    if (ACTIVE_STATUSES.has(sub.status)) {
      if (sub.status === "PAST_DUE" && sub.gracePeriodEndsAt) {
        // Allow access during grace window; block only after expiry
        if (new Date() > new Date(sub.gracePeriodEndsAt)) {
          throw new ForbiddenException(
            "Your subscription payment has failed and the grace period has expired. " +
              "Please update your payment method to continue.",
          );
        }
      }
      return true;
    }

    if (sub.status === "UNPAID") {
      throw new ForbiddenException(
        "Your subscription is unpaid. Please update your payment method to restore access.",
      );
    }

    if (sub.status === "CANCELLED") {
      throw new ForbiddenException(
        "Your subscription has been cancelled. Please contact support to reactivate.",
      );
    }

    // Any other status (INCOMPLETE, PAUSED, etc.) — block
    throw new ForbiddenException(
      `Subscription status '${sub.status}' does not permit access. Please contact support.`,
    );
  }

  /**
   * The per-location subscriptions that actually take the money.
   *
   * A tenant passes if ANY of its locations is in good standing. Billing is
   * per location but access is per tenant, so a two-shop operator who has paid
   * for one of them is a customer, not a defaulter — and cutting off the paid
   * shop because the other lapsed would be indefensible.
   *
   * Returns true (with a log) rather than throwing while in observe mode, so
   * this can be switched on with evidence rather than hope.
   */
  private async checkMerchantSubscriptions(
    user: AuthenticatedUser,
    request: { method?: string; url?: string },
  ): Promise<boolean> {
    const mode = enforcementMode();
    if (mode === "off") return true;

    // FAIL OPEN. This guard is global, so anything thrown here — a dropped
    // connection, a missing column mid-migration — takes down every
    // authenticated request on the platform, for every tenant, paying or not.
    // A few minutes of unenforced billing is recoverable; a total outage
    // during Friday service is not.
    let subs: Array<{ status: string; currentPeriodEnd: Date | null }>;
    try {
      subs = await (this.prisma as any).merchantSubscription.findMany({
        where: { tenantId: user.tenantId },
        select: { status: true, currentPeriodEnd: true, locationId: true },
      });
    } catch (err) {
      this.logger.error(
        `billing check failed for tenant ${user.tenantId}, allowing through: ${(err as Error).message}`,
      );
      return true;
    }

    // Never billed at all — a tenant mid-onboarding, or one we've chosen not
    // to charge. Not a defaulter; nothing to enforce.
    if (!subs.length) return true;

    const ok = subs.some((s) => MERCHANT_OK_STATUSES.has(String(s.status)));
    if (ok) return true;

    // Everything they have is unpaid or cancelled. Give the grace window from
    // the latest period end before anything actually stops working.
    const latestEnd = subs
      .map((s) => s.currentPeriodEnd)
      .filter((d): d is Date => !!d)
      .map((d) => new Date(d).getTime())
      .sort((a, b) => b - a)[0];
    if (latestEnd) {
      const graceEnds = latestEnd + MERCHANT_GRACE_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() < graceEnds) return true;
    }

    const statuses = subs.map((s) => s.status).join(",");
    if (mode === "observe") {
      this.logger.warn(
        `[billing:observe] would block tenant ${user.tenantId} ` +
          `(subscriptions: ${statuses}) on ${request?.method ?? "?"} ${request?.url ?? "?"} — ` +
          `set BILLING_ENFORCEMENT=enforce to make this real`,
      );
      return true;
    }

    this.logger.warn(
      `[billing:enforce] blocked tenant ${user.tenantId} (subscriptions: ${statuses})`,
    );
    throw new ForbiddenException(
      "Your subscription payment hasn't gone through. Please update your payment " +
        "method on the Subscription page to restore access.",
    );
  }
}
