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
