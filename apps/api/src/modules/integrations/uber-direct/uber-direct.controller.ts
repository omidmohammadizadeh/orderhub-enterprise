// Phase BI — Uber Direct config + dispatch endpoints.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { IsBoolean, IsIn, IsOptional, IsString } from "class-validator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { UberDirectConfigService } from "./uber-direct-config.service";
import { UberDirectDispatchService } from "./uber-direct-dispatch.service";

class UpsertUberDirectDto {
  @IsString() customerId!: string;
  @IsString() clientId!: string;
  @IsString() clientSecret!: string;
  @IsOptional() @IsString() signingKey?: string;
  @IsOptional() @IsIn(["sandbox", "production"]) environment?: string;
}
class ToggleUberDirectDto {
  @IsBoolean() active!: boolean;
}

@ApiTags("uber-direct")
@ApiBearerAuth()
@Controller({ path: "uber-direct", version: "1" })
export class UberDirectController {
  constructor(
    private readonly config: UberDirectConfigService,
    private readonly dispatch: UberDirectDispatchService,
    private readonly cfg: ConfigService,
  ) {}

  private apiBase(): string {
    return (
      this.cfg.get<string>("app.apiUrl") ??
      "https://orderhub-api-0re6.onrender.com"
    ).replace(/\/$/, "");
  }

  @Get("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Uber Direct config for a location (masked; no secret)" })
  getConfig(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
  }

  @Put("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Set the location's Uber Direct credentials" })
  upsert(
    @Param("locationId") locationId: string,
    @Body() dto: UpsertUberDirectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.upsert(locationId, user.tenantId, dto);
  }

  @Post("locations/:locationId/toggle")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Activate/deactivate Uber Direct for a location" })
  toggle(
    @Param("locationId") locationId: string,
    @Body() dto: ToggleUberDirectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.setActive(locationId, user.tenantId, !!dto.active);
  }

  @Post("orders/:orderId/quote")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Quote an Uber Direct delivery for an order (no charge)" })
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
      "Dispatch an order to an Uber Direct courier (debits the location wallet; admin bypasses)",
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
  @ApiOperation({ summary: "Cancel the Uber Direct courier for an order" })
  cancel(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.cancel({ orderId, tenantId: user.tenantId });
  }
}
