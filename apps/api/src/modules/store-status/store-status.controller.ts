import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
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
  // TILL_ROLES, not a hand-written list. This route previously named
  // STAFF/MANAGER/DARK_KITCHEN_MANAGER but omitted OWNER — the scoped
  // location-owner Team Role — so owners were refused by the guard and
  // saw an empty Store Status tab instead of their own stores. That is
  // the exact drift TILL_ROLES exists to prevent (see its comment), and
  // this is a till-facing operational view: pauses, busy mode and 86'd
  // items are things anyone working the counter needs to see.
  //
  // Access is NOT visibility: OWNER is deliberately absent from
  // TENANT_WIDE below, so an owner is narrowed to their UserLocation
  // set — on "All locations" exactly as on a single site.
  @Roles(...TILL_ROLES)
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
