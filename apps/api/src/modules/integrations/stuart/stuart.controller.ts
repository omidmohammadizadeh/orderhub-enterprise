// Phase BH — Stuart config + dispatch endpoints.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from "class-validator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { StuartConfigService } from "./stuart-config.service";
import { StuartDispatchService } from "./stuart-dispatch.service";

class UpsertStuartDto {
  @IsString() clientId!: string;
  @IsString() clientSecret!: string;
  @IsOptional() @IsIn(["sandbox", "production"]) environment?: string;
}
class ToggleStuartDto {
  @IsBoolean() active!: boolean;
}
class BulkStuartDto {
  // The run's real limit (8) is enforced — with a readable message — by the
  // service; this only stops an absurd payload reaching it.
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) orderIds!: string[];
}

@ApiTags("stuart")
@ApiBearerAuth()
@Controller({ path: "stuart", version: "1" })
export class StuartController {
  constructor(
    private readonly config: StuartConfigService,
    private readonly dispatch: StuartDispatchService,
    private readonly cfg: ConfigService,
  ) {}

  private apiBase(): string {
    return (
      this.cfg.get<string>("app.apiUrl") ??
      "https://orderhub-api-0re6.onrender.com"
    ).replace(/\/$/, "");
  }

  // ── Config (owner / finance) ────────────────────────────────────────────

  @Get("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Stuart config for a location (masked; no secret)" })
  getConfig(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
  }

  @Put("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Set the location's Stuart client ID + secret" })
  upsert(
    @Param("locationId") locationId: string,
    @Body() dto: UpsertStuartDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.upsert(locationId, user.tenantId, dto);
  }

  @Post("locations/:locationId/toggle")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Activate/deactivate Stuart dispatch for a location" })
  toggle(
    @Param("locationId") locationId: string,
    @Body() dto: ToggleStuartDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.setActive(locationId, user.tenantId, !!dto.active);
  }

  // ── Dispatch (operational) ──────────────────────────────────────────────

  @Post("orders/:orderId/quote")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Quote a Stuart delivery for an order (no charge)" })
  quote(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.quote({ orderId, tenantId: user.tenantId });
  }

  @Post("orders/:orderId/dispatch")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Dispatch an order to a Stuart courier (debits the location wallet; admin bypasses)",
  })
  dispatchOrder(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.dispatch({
      orderId,
      tenantId: user.tenantId,
      userId: user.userId,
      isAdmin: user.role === "PLATFORM_ADMIN",
    });
  }

  @Post("orders/:orderId/cancel")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Cancel the Stuart courier for an order" })
  cancel(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.cancel({ orderId, tenantId: user.tenantId });
  }

  // ── Bulk: several orders on one courier ─────────────────────────────────

  @Post("bulk/quote")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Quote ONE Stuart courier for several orders from the same shop (a multi-drop run, up to 8). No charge.",
  })
  quoteBulk(@Body() dto: BulkStuartDto, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.quoteBulk({ orderIds: dto.orderIds, user });
  }

  @Post("bulk/dispatch")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Dispatch several orders from the same shop to ONE Stuart courier (up to 8). Debits the dispatch fee per order; admin bypasses.",
  })
  dispatchBulk(
    @Body() dto: BulkStuartDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.dispatchBulk({
      orderIds: dto.orderIds,
      user,
      isAdmin: user.role === "PLATFORM_ADMIN",
    });
  }
}
