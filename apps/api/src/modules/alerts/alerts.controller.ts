import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import {
  AlertsService,
  type AckDto,
  type UpsertAlertDto,
} from "./alerts.service";

const MANAGE_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
] as const;

@ApiTags("alerts")
@ApiBearerAuth()
@Controller({ path: "alerts", version: "1" })
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.alerts.list(user.tenantId, locationId);
  }

  @Put()
  @Roles(...MANAGE_ROLES)
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertAlertDto,
  ) {
    return this.alerts.upsert(user.tenantId, dto);
  }

  @Delete(":id")
  @Roles(...MANAGE_ROLES)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.alerts.remove(user.tenantId, id);
  }

  @Post("ack")
  @HttpCode(HttpStatus.OK)
  ack(@CurrentUser() user: AuthenticatedUser, @Body() dto: AckDto) {
    return this.alerts.acknowledge(user.tenantId, user.userId, dto);
  }
}
