import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@orderhub/database";
import { ROLES_KEY, PERMISSIONS_KEY } from "../decorators/roles.decorator";
import { ROLE_PERMISSIONS } from "@orderhub/shared";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

// Role and permission resolution order:
//   1. PLATFORM_ADMIN bypasses everything.
//   2. If @Roles(...) is set, user's role must be in the list (or higher in hierarchy).
//   3. If @RequirePermissions(...) is set, user must have ALL listed permissions
//      (from role defaults + personal overrides merged in AuthService.getMe).
//
// Apply AFTER JwtAuthGuard. The user must already be authenticated.
@Injectable()
export class RolesGuard implements CanActivate {
  // Hierarchy order — higher index = more privileged.
  // A user with role X implicitly passes a check for any role with a lower index.
  private static readonly HIERARCHY: UserRole[] = [
    "VIEWER",
    "DRIVER",
    "KITCHEN_STAFF",
    "CASHIER",
    "MANAGER",
    "TENANT_OWNER",
    "PLATFORM_ADMIN",
  ];

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No restrictions set — allow
    if (!requiredRoles?.length && !requiredPerms?.length) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user) throw new ForbiddenException("Not authenticated");

    // PLATFORM_ADMIN bypasses all role and permission checks
    if (user.role === "PLATFORM_ADMIN") return true;

    // ── Role check ────────────────────────────────────────
    // Two ways to pass:
    //   1. EXACT match — the user's role is explicitly listed.
    //   2. HIERARCHY escalation — the user's role outranks the lowest
    //      *ranked* role in the list (so @Roles("MANAGER") still admits
    //      TENANT_OWNER / PLATFORM_ADMIN).
    //
    // Only roles that actually appear in HIERARCHY take part in (2). Roles
    // outside it (OWNER, FINANCIAL_AGENT, STAFF, DARK_KITCHEN_MANAGER…)
    // resolve to indexOf === -1, and the old `userLevel < min(...)` test
    // turned that -1 into a minimum that EVERY authenticated user cleared —
    // i.e. listing OWNER on a route silently opened it to VIEWER/DRIVER too.
    // Exact-match + ranked-only escalation closes that hole and lets
    // non-hierarchy roles be granted a route without widening it.
    if (requiredRoles?.length) {
      const allowed = new Set<string>(requiredRoles as unknown as string[]);
      let permitted = allowed.has(user.role as unknown as string);
      if (!permitted) {
        const userLevel = RolesGuard.HIERARCHY.indexOf(user.role);
        const rankedRequired = requiredRoles
          .map((r) => RolesGuard.HIERARCHY.indexOf(r))
          .filter((i) => i >= 0);
        permitted =
          userLevel >= 0 &&
          rankedRequired.length > 0 &&
          userLevel >= Math.min(...rankedRequired);
      }
      if (!permitted) {
        throw new ForbiddenException(
          `Requires role: ${requiredRoles.join(" or ")}`,
        );
      }
    }

    // ── Permission check ──────────────────────────────────
    if (requiredPerms?.length) {
      // Build the effective permission set:
      // role defaults + user-specific overrides (stored in JWT)
      const roleDefaults = (ROLE_PERMISSIONS[user.role] ?? []) as string[];
      const effective = new Set([...roleDefaults, ...user.permissions]);

      const missing = requiredPerms.filter((p) => !effective.has(p));
      if (missing.length > 0) {
        throw new ForbiddenException(
          `Missing permissions: ${missing.join(", ")}`,
        );
      }
    }

    return true;
  }
}
