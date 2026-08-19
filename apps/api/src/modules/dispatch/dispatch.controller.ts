import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { DispatchService } from "./dispatch.service";
import {
  DriverEarningsService,
  type PostcodeFee,
} from "./driver-earnings.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Dispatch is shop-floor work — whoever is on shift hands orders to drivers.
// STAFF included deliberately; DispatchService already constrains every query
// to the caller's UserLocation (see its listOrders comment), so widening the
// role does not widen which shops they can see.
const DISPATCH_ROLES = [
  "MANAGER",
  "TENANT_OWNER",
  "PLATFORM_ADMIN",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "STAFF",
] as const;

@ApiTags("dispatch")
@ApiBearerAuth()
@Controller({ path: "dispatch", version: "1" })
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly earnings: DriverEarningsService,
  ) {}

  @Get("feed")
  @Roles(...DISPATCH_ROLES)
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
  @Roles(...DISPATCH_ROLES)
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

  @Get("online-drivers")
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({
    summary:
      "Online own-fleet drivers for the dispatch modal (?locationId= to scope).",
  })
  onlineDrivers(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.dispatch.listOnlineDrivers(user, locationId);
  }

  @Post("assign")
  @HttpCode(HttpStatus.OK)
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "Own-fleet: assign ordered orders to a driver (multi-drop)" })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { driverId: string; orderIds: string[] },
  ) {
    return this.dispatch.assignToDriver(user, body.driverId, body.orderIds);
  }

  @Post("unassign")
  @HttpCode(HttpStatus.OK)
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "Remove an order from its driver and return it to the board" })
  unassign(@CurrentUser() user: AuthenticatedUser, @Body() body: { orderId: string }) {
    return this.dispatch.unassign(user, body.orderId);
  }

  // ── Driver pay + cash-up (Phase BG) ──────────────────────────────────────
  @Patch("drivers/:driverId/earnings")
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "Set a driver's home location + pay (start-up fee + per-postcode fees)" })
  updateEarnings(
    @CurrentUser() user: AuthenticatedUser,
    @Param("driverId") driverId: string,
    @Body()
    body: { locationId?: string | null; startupFee?: number; postcodeFees?: PostcodeFee[] },
  ) {
    return this.earnings.updateEarningsConfig(user, driverId, body);
  }

  @Get("drivers/:driverId/cashup")
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "Cash-up figures: outstanding (no dates) or a date range" })
  cashUpView(
    @CurrentUser() user: AuthenticatedUser,
    @Param("driverId") driverId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.earnings.cashUpView(user, driverId, { from, to });
  }

  @Post("drivers/:driverId/cashup")
  @HttpCode(HttpStatus.OK)
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "Settle the driver's outstanding cash-up (clears the balance)" })
  settleCashUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param("driverId") driverId: string,
  ) {
    return this.earnings.settleCashUp(user, driverId);
  }

  @Get("drivers/:driverId/cashups")
  @Roles(...DISPATCH_ROLES)
  @ApiOperation({ summary: "History of settled cash-ups for a driver" })
  listCashUps(
    @CurrentUser() user: AuthenticatedUser,
    @Param("driverId") driverId: string,
  ) {
    return this.earnings.listCashUps(user, driverId);
  }
}
