import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  DirectOrderingService,
  UpdateDirectOrderingConfigDto,
} from "./direct-ordering.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("direct-ordering")
@BillingExempt()
@Controller({ path: "direct-ordering", version: "1" })
export class DirectOrderingController {
  constructor(private readonly service: DirectOrderingService) {}

  @ApiBearerAuth()
  @Get("config")
  @ApiOperation({ summary: "Get direct ordering config for a location" })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.service.get(user.tenantId, locationId);
  }

  @ApiBearerAuth()
  @Patch("config")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update direct ordering config" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() dto: UpdateDirectOrderingConfigDto,
  ) {
    return this.service.update(user.tenantId, locationId, dto);
  }

  @Public()
  @Get("public/:locationId")
  @ApiOperation({
    summary: "Public read for storefront — no tenant secrets exposed",
  })
  publicGet(@Param("locationId") locationId: string) {
    return this.service.getPublic(locationId);
  }
}
