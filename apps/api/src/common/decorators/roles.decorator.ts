import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "@orderhub/database";

export const ROLES_KEY = "roles";
export const PERMISSIONS_KEY = "requiredPermissions";

// Restricts a route to one or more roles.
// Usage: @Roles("MANAGER", "TENANT_OWNER")
// Combined with RolesGuard — the guard checks the authenticated user's role.
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

// Fine-grained permission gate. Used when a sub-action within a role
// is restricted (e.g. all managers can view orders but only some can refund).
// Usage: @RequirePermissions("orders:refund")
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Anyone who works the till.
 *
 * Phase AR added the Team Roles (OWNER / STAFF / DARK_KITCHEN_MANAGER)
 * alongside the legacy names and said existing @Roles decorators would keep
 * working — true for the legacy roles, but every till-facing route was left
 * listing ONLY legacy names. So a real person assigned STAFF through the Team
 * Roles UI could open the POS and then be refused at the moment they tried to
 * take money: "Requires role: CASHIER or MANAGER or TENANT_OWNER or
 * PLATFORM_ADMIN", mid-service, with a customer waiting.
 *
 * Spread it — `@Roles(...TILL_ROLES)` — so the two naming generations can
 * never drift apart again on a route that a cashier has to be able to use.
 *
 * Deliberately NOT for money-out or account-level routes (refunds, payouts,
 * Stripe Connect onboarding); those stay on their own explicit lists.
 */
export const TILL_ROLES = [
  "CASHIER",
  "MANAGER",
  "TENANT_OWNER",
  "PLATFORM_ADMIN",
  // Phase AR equivalents of the four above.
  "STAFF",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
] as const satisfies readonly UserRole[];
