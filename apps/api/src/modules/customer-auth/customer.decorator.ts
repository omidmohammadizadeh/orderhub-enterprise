// Phase AP-AUTH — convenience decorator + guard for customer routes.
//
//   @UseGuards(CustomerJwtGuard)
//   @Get("me")
//   me(@CurrentCustomer() customer: any) { ... }

import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class CustomerJwtGuard extends AuthGuard("customer-jwt") {}

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
