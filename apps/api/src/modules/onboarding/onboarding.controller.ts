import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional } from "class-validator";
import { OnboardingService } from "./onboarding.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class TransitionStatusDto {
  @IsString()
  @IsNotEmpty()
  targetStatus!: string;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class AdminOverrideDto {
  @IsString()
  @IsNotEmpty()
  targetStatus!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class EmergencyControlDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags("onboarding")
@ApiBearerAuth()
@BillingExempt() // Emergency provider/printer controls must always be accessible regardless of billing state
@Controller({ path: "onboarding", version: "1" })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("locations")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @ApiOperation({ summary: "List all locations with go-live status (wizard overview)" })
  listLocations(
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
  ) {
    // PLATFORM_ADMIN can pass an explicit tenantId; others are scoped to their own tenant
    const scopedTenantId = user.role === "PLATFORM_ADMIN" ? tenantId : user.tenantId;
    return this.onboarding.listLocationsWithStatus(scopedTenantId);
  }

  @Get("locations/:locationId/readiness")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @ApiOperation({ summary: "Get full readiness check for a location" })
  getReadiness(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride
        ? tenantIdOverride
        : user.tenantId;
    return this.onboarding.getLocationReadiness(locationId, tenantId);
  }

  @Post("locations/:locationId/transition")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Transition location go-live status" })
  transition(
    @Param("locationId") locationId: string,
    @Body() dto: TransitionStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride
        ? tenantIdOverride
        : user.tenantId;
    return this.onboarding.transitionGoLiveStatus(
      locationId,
      tenantId,
      user.sub,
      dto.targetStatus,
      dto.reason,
    );
  }

  @Post("locations/:locationId/admin-override")
  @Roles("PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Admin override: force a go-live status (PLATFORM_ADMIN only)" })
  adminOverride(
    @Param("locationId") locationId: string,
    @Body() dto: AdminOverrideDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId = tenantIdOverride ?? user.tenantId;
    return this.onboarding.adminOverride(
      locationId,
      tenantId,
      user.sub,
      dto.targetStatus,
      dto.reason,
    );
  }

  @Post("locations/:locationId/record-test-order")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Record that a test order was completed for this location" })
  recordTestOrder(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride
        ? tenantIdOverride
        : user.tenantId;
    return this.onboarding.recordTestOrder(locationId, tenantId, user.sub);
  }

  @Post("locations/:locationId/record-test-print")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Record that a test print was completed for this location" })
  recordTestPrint(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride
        ? tenantIdOverride
        : user.tenantId;
    return this.onboarding.recordTestPrint(locationId, tenantId, user.sub);
  }

  // ── Emergency controls ────────────────────────────────────────────────────

  @Post("locations/:locationId/providers/:integrationId/pause")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Emergency: disable one provider for a location (audited)" })
  pauseProvider(
    @Param("locationId") locationId: string,
    @Param("integrationId") integrationId: string,
    @Body() dto: EmergencyControlDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride ? tenantIdOverride : user.tenantId;
    return this.onboarding.pauseProvider(locationId, tenantId, integrationId, user.sub, dto.reason);
  }

  @Post("locations/:locationId/providers/:integrationId/resume")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume a paused provider for a location (audited)" })
  resumeProvider(
    @Param("locationId") locationId: string,
    @Param("integrationId") integrationId: string,
    @Body() dto: EmergencyControlDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride ? tenantIdOverride : user.tenantId;
    return this.onboarding.resumeProvider(locationId, tenantId, integrationId, user.sub, dto.reason);
  }

  @Post("locations/:locationId/printers/:printerId/pause")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Emergency: deactivate a printer for a location (audited)" })
  pausePrinter(
    @Param("locationId") locationId: string,
    @Param("printerId") printerId: string,
    @Body() dto: EmergencyControlDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride ? tenantIdOverride : user.tenantId;
    return this.onboarding.pausePrinter(locationId, tenantId, printerId, user.sub, dto.reason);
  }

  @Post("locations/:locationId/printers/:printerId/resume")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume a deactivated printer for a location (audited)" })
  resumePrinter(
    @Param("locationId") locationId: string,
    @Param("printerId") printerId: string,
    @Body() dto: EmergencyControlDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantIdOverride?: string,
  ) {
    const tenantId =
      user.role === "PLATFORM_ADMIN" && tenantIdOverride ? tenantIdOverride : user.tenantId;
    return this.onboarding.resumePrinter(locationId, tenantId, printerId, user.sub, dto.reason);
  }
}
