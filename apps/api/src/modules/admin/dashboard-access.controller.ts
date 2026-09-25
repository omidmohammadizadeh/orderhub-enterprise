import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DASHBOARD_TABS } from "@orderhub/shared";
import { DashboardAccessService } from "./dashboard-access.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Admin Dashboard → Dashboard access.
//
// PLATFORM_ADMIN only, and deliberately not TENANT_OWNER: this decides what a
// tenant's own owners are allowed to see, so handing it to an owner would let
// them undo it on themselves. RolesGuard matches exactly here — TENANT_OWNER
// sits below PLATFORM_ADMIN in the hierarchy, so it can't escalate in.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/dashboard-access", version: "1" })
export class DashboardAccessController {
  constructor(private readonly access: DashboardAccessService) {}

  @Get("tabs")
  @ApiOperation({ summary: "The tabs that can be switched off per location" })
  tabs() {
    return DASHBOARD_TABS;
  }

  @Get()
  @ApiOperation({ summary: "Dashboard access for every location in the tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.access.list(user.tenantId);
  }

  @Get(":locationId")
  @ApiOperation({ summary: "Dashboard access for one location" })
  get(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.access.get(user.tenantId, locationId);
  }

  @Put(":locationId")
  @ApiOperation({ summary: "Replace the disabled-tab list for one location" })
  set(
    @Param("locationId") locationId: string,
    @Body() body: { disabledTabs?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.access.set(user.tenantId, locationId, body?.disabledTabs, {
      userId: user.userId,
      role: user.role as string,
    });
  }

  @Post(":locationId/apply-to")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Copy this location's disabled-tab list onto other locations",
  })
  applyTo(
    @Param("locationId") locationId: string,
    @Body() body: { locationIds?: unknown },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.access.applyTo(
      user.tenantId,
      locationId,
      body?.locationIds,
      { userId: user.userId, role: user.role as string },
    );
  }
}
