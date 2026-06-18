import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { StoreStatusService } from "./store-status.service";

// Phase AW-21 — Store Status overview. Read-only; pause/snooze
// mutations stay on their own controllers (PauseController,
// MenuAvailabilityController).

@ApiTags("store-status")
@ApiBearerAuth()
@Controller({ path: "store-status", version: "1" })
export class StoreStatusController {
  constructor(private readonly service: StoreStatusService) {}

  @Get("overview")
  @Roles("STAFF", "MANAGER", "DARK_KITCHEN_MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Active operational issues across the tenant: pauses, busy modes, item snoozes, out-of-stock items.",
  })
  overview(@CurrentUser() user: AuthenticatedUser) {
    // Same scoping rule as locations: tenant-wide roles see every
    // location; everyone else gets narrowed to their UserLocation set.
    const TENANT_WIDE = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);
    const scopedUserId = TENANT_WIDE.has(user.role as string)
      ? undefined
      : user.userId;
    return this.service.getOverview(user.tenantId, scopedUserId);
  }
}
