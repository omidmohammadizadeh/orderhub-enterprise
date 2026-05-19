import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

export const BILLING_EXEMPT_KEY = "billingExempt";

// Mark a route as exempt from billing checks (e.g. order endpoints, printer endpoints).
// IMPORTANT: order ingestion and printer polling must NEVER be gated by billing status.
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT_KEY, true);

const ACTIVE_STATUSES = new Set([
  "TRIALING",
  "ACTIVE",
  "FREE_PILOT",
  "PAST_DUE", // allowed during grace period — see below
]);

@Injectable()
export class BillingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

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

    if (!sub) return true; // no subscription record — allow (not yet billed)

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
}
