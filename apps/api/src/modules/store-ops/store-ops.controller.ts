import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { StoreOpsService, UpdateStoreStatusDto } from "./store-ops.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("store-ops")
@ApiBearerAuth()
@BillingExempt() // Emergency store close/resume must never be blocked by billing state
@Controller({ path: "store-ops", version: "1" })
export class StoreOpsController {
  constructor(private readonly storeOps: StoreOpsService) {}

  @Get("brand/:brandId")
  @ApiOperation({ summary: "Get store status for all locations under a brand" })
  getByBrand(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.getStatusByBrand(brandId, user.tenantId);
  }

  @Get(":locationId")
  @ApiOperation({ summary: "Get current store status for a location" })
  getStatus(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.getStatus(locationId, user.tenantId);
  }

  @Patch(":locationId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update store status (open/close/pause/busy/prep time)" })
  updateStatus(
    @Param("locationId") locationId: string,
    @Body() dto: UpdateStoreStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.updateStatus(locationId, user.tenantId, dto);
  }

  @Post(":locationId/emergency-close")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Immediately close the store (emergency)" })
  emergencyClose(
    @Param("locationId") locationId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.emergencyClose(locationId, user.tenantId, body.reason);
  }

  @Post(":locationId/resume")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume store (open + clear pause)" })
  resume(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.resume(locationId, user.tenantId);
  }

  @Patch(":locationId/opening-hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update regular opening hours" })
  updateHours(
    @Param("locationId") locationId: string,
    @Body() body: { hours: Array<{ day: number; open: string; close: string }> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.updateOpeningHours(locationId, user.tenantId, body.hours);
  }

  @Patch(":locationId/delivery-config")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update delivery zone and fee configuration" })
  updateDeliveryConfig(
    @Param("locationId") locationId: string,
    @Body() body: {
      deliveryFeeFixed?: number;
      deliveryRadius?: number;
      minimumOrder?: number;
      estimatedDeliveryMinutes?: number;
      deliveryEnabled?: boolean;
      collectionEnabled?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeOps.updateDeliveryConfig(locationId, user.tenantId, body);
  }
}
