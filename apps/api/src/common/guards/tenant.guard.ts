import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

export const TENANT_PARAM_KEY = "tenantParamName";

// Verifies that a URL parameter (usually :tenantId) matches the tenantId
// embedded in the authenticated user's JWT.
//
// This prevents horizontal privilege escalation:
//   GET /api/v1/tenants/other-tenant-id/orders  → 403
//
// Usage:
//   @UseGuards(JwtAuthGuard, TenantGuard)
//   @TenantParam("tenantId")          // optional — defaults to "tenantId"
//   @Get(":tenantId/orders")
//
// PLATFORM_ADMIN bypasses this check and can access any tenant.
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName =
      this.reflector.getAllAndOverride<string>(TENANT_PARAM_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "tenantId";

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user) throw new ForbiddenException("Not authenticated");
    if (user.role === "PLATFORM_ADMIN") return true;

    const paramTenantId: string | undefined = request.params[paramName];

    // If the route doesn't have the param, nothing to enforce
    if (!paramTenantId) return true;

    if (paramTenantId !== user.tenantId) {
      throw new ForbiddenException("Access denied to this tenant");
    }

    return true;
  }
}

// Companion decorator to set which param name holds the tenantId
import { SetMetadata } from "@nestjs/common";
export const TenantParam = (paramName = "tenantId") =>
  SetMetadata(TENANT_PARAM_KEY, paramName);
