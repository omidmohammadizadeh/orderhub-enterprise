import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

// Parameter decorator that extracts request.user (set by JwtStrategy).
// Usage: @CurrentUser() user: AuthenticatedUser
// Never read tenantId from query params or body — always use this.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AuthenticatedUser;
  },
);
