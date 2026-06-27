import { Body, Controller, Get, Post, Query, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { DispatchService } from "./dispatch.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("dispatch")
@ApiBearerAuth()
@Controller({ path: "dispatch", version: "1" })
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get("feed")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({
    summary:
      "Location-scoped dispatch feed: location pins, live order pins (with countdown deadline) and online driver dots. ?location=all or a specific locationId.",
  })
  feed(
    @CurrentUser() user: AuthenticatedUser,
    @Query("location") location?: string,
  ) {
    return this.dispatch.getFeed(user, location);
  }

  @Get("operator")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({
    summary:
      "Operator dashboard: delivery analytics, out-for-delivery, overdue attention, online/busy drivers, per-driver active jobs + cash-up, recent failed/cancelled. ?location=all or a locationId.",
  })
  operator(
    @CurrentUser() user: AuthenticatedUser,
    @Query("location") location?: string,
  ) {
    return this.dispatch.getOperatorDashboard(user, location);
  }

  @Post("assign")
  @HttpCode(HttpStatus.OK)
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({ summary: "Own-fleet: assign ordered orders to a driver (multi-drop)" })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { driverId: string; orderIds: string[] },
  ) {
    return this.dispatch.assignToDriver(user, body.driverId, body.orderIds);
  }

  @Post("unassign")
  @HttpCode(HttpStatus.OK)
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({ summary: "Remove an order from its driver and return it to the board" })
  unassign(@CurrentUser() user: AuthenticatedUser, @Body() body: { orderId: string }) {
    return this.dispatch.unassign(user, body.orderId);
  }
}
