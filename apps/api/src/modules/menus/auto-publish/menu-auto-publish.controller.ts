import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { MenuAutoPublishService } from "./menu-auto-publish.service";

const EDITORS = ["OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"] as const;

@ApiTags("Menu auto publish")
@ApiBearerAuth()
@Controller({ version: "1" })
export class MenuAutoPublishController {
  constructor(private readonly autoPublish: MenuAutoPublishService) {}

  @Get("menus/:menuId/auto-publish")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "The menu's auto-publish schedule, plus where a run would publish" })
  get(@Param("menuId") menuId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.autoPublish.get(menuId, user.tenantId);
  }

  @Put("menus/:menuId/auto-publish")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Save the schedule: channels, days (0=Sun), times (HH:mm), timezone, enabled" })
  save(
    @Param("menuId") menuId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.autoPublish.save(menuId, user.tenantId, body ?? {}, user.userId);
  }

  @Delete("menus/:menuId/auto-publish")
  @Roles(...EDITORS)
  remove(@Param("menuId") menuId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.autoPublish.remove(menuId, user.tenantId);
  }

  @Post("menus/:menuId/auto-publish/run")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Run the saved schedule now (publishes to every chosen channel)" })
  runNow(@Param("menuId") menuId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.autoPublish.runNow(menuId, user.tenantId);
  }
}
