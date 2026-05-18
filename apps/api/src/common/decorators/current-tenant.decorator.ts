import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

export const CurrentTenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser;
    return user.tenantId;
  },
);
