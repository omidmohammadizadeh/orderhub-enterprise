// Team → Tablet logins. The shared per-shop counter-tablet sign-in; see
// tablet-logins.service.ts. Same callers as the rest of Team Roles, and each
// of them only for the locations they themselves can reach.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { TabletLoginsService } from "./tablet-logins.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

const MANAGE_TABLET_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("team")
@ApiBearerAuth()
@Roles(...MANAGE_TABLET_ROLES)
@Controller({ path: "team/tablet-logins", version: "1" })
export class TabletLoginsController {
  constructor(private readonly tablets: TabletLoginsService) {}

  @Get()
  @ApiOperation({ summary: "Every shop I manage, with its tablet login if it has one" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.tablets.list(user);
  }

  @Post(":locationId")
  @ApiOperation({ summary: "Create the shop's tablet login with a password" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: { password?: string },
  ) {
    return this.tablets.create(user, locationId, body?.password);
  }

  @Post(":locationId/password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset the tablet password (signs the shop's tablets out)" })
  resetPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: { password?: string },
  ) {
    return this.tablets.resetPassword(user, locationId, body?.password);
  }

  @Patch(":locationId")
  @ApiOperation({ summary: "Turn the login on/off, or allow it to see Analytics" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: { analytics?: boolean; isActive?: boolean },
  ) {
    return this.tablets.update(user, locationId, body ?? {});
  }

  @Delete(":locationId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove the shop's tablet login" })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    await this.tablets.remove(user, locationId);
    return { ok: true };
  }
}
