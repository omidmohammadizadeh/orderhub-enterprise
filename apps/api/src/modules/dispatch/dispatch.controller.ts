import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { DispatchService } from "./dispatch.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("dispatch")
@ApiBearerAuth()
@Controller({ path: "dispatch", version: "1" })
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get("feed")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({
    summary:
      "Location-scoped dispatch feed: location pins, live order pins (with countdown deadline) and online driver dots. ?location=all or a specific locationId.",
  })
  feed(
    @CurrentUser() user: AuthenticatedUser,
    @Query("location") location?: string,
  ) {
    return this.dispatch.getFeed(user, location);
  }
}
