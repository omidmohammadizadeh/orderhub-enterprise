// Phase LG — dashboard Logs page feed.

import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ActivityLogService } from "./activity-log.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("logs")
@Controller({ path: "logs", version: "1" })
export class LogsController {
  constructor(private readonly activity: ActivityLogService) {}

  @Get()
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER")
  @ApiOperation({ summary: "Activity feed (menu/orders/inventory/status)" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("category") category?: string,
    @Query("channel") channel?: string,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.activity.list(user.tenantId, {
      category: category || undefined,
      channel: channel || undefined,
      locationId: locationId || undefined,
      status: status || undefined,
      cursor: cursor || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
