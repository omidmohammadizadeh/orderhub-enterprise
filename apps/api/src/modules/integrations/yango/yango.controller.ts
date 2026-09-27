// Phase BK — Yango Delivery config + dispatch endpoints.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString } from "class-validator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { YangoConfigService, YANGO_MODES, YANGO_TAXI_CLASSES } from "./yango-config.service";
import { YangoDispatchService } from "./yango-dispatch.service";

class UpsertYangoDto {
  /** Optional on later saves — blank keeps the stored token. */
  @IsOptional() @IsString() token?: string;
  @IsOptional() @IsIn([...YANGO_MODES]) mode?: string;
  /** Required to switch INTO live: every dispatch then books a real courier. */
  @IsOptional() @IsBoolean() acknowledgeLiveCouriers?: boolean;
  @IsOptional() @IsIn([...YANGO_TAXI_CLASSES]) taxiClass?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsNumber() pickupLat?: number;
  @IsOptional() @IsNumber() pickupLng?: number;
}
class ToggleYangoDto {
  @IsBoolean() active!: boolean;
}
class CancelYangoDto {
  /** Needed once the courier has reached the shop and Yango charges to cancel. */
  @IsOptional() @IsBoolean() confirmPaid?: boolean;
}

@ApiTags("yango")
@ApiBearerAuth()
@Controller({ path: "yango", version: "1" })
export class YangoController {
  constructor(
    private readonly config: YangoConfigService,
    private readonly dispatch: YangoDispatchService,
    private readonly cfg: ConfigService,
  ) {}

  private apiBase(): string {
    return (this.cfg.get<string>("app.apiUrl") ?? "https://orderhub-api-0re6.onrender.com").replace(/\/$/, "");
  }

  @Get("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT", "MANAGER")
  @ApiOperation({ summary: "Yango config for a location (masked; no token)" })
  getConfig(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
  }

  @Put("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Set the location's Yango token, mode, class and pickup point" })
  upsert(
    @Param("locationId") locationId: string,
    @Body() dto: UpsertYangoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.upsert(locationId, user.tenantId, dto);
  }

  @Post("locations/:locationId/verify")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Check the token works and the pickup point is in a Yango zone (free)" })
  verify(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.verify(locationId, user.tenantId);
  }

  @Post("locations/:locationId/toggle")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Activate/deactivate Yango for a location" })
  toggle(
    @Param("locationId") locationId: string,
    @Body() dto: ToggleYangoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.setActive(locationId, user.tenantId, !!dto.active);
  }

  @Post("orders/:orderId/quote")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Quote a Yango delivery for an order (no claim, no charge)" })
  quote(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.quote({ orderId, tenantId: user.tenantId });
  }

  @Post("orders/:orderId/dispatch")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Book a Yango courier (live mode only; debits the location wallet; admin bypasses)",
  })
  dispatchOrder(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.dispatch({
      orderId,
      tenantId: user.tenantId,
      userId: user.userId,
      isAdmin: user.role === "PLATFORM_ADMIN",
    });
  }

  @Post("orders/:orderId/cancel")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Cancel the Yango courier (a paid cancel needs confirmPaid)" })
  cancel(
    @Param("orderId") orderId: string,
    @Body() dto: CancelYangoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.cancel({ orderId, tenantId: user.tenantId, confirmPaid: dto?.confirmPaid === true });
  }

  @Post("orders/:orderId/refresh-status")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Re-read this delivery from Yango now" })
  refreshStatus(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.refreshStatus({ orderId, tenantId: user.tenantId });
  }
}
