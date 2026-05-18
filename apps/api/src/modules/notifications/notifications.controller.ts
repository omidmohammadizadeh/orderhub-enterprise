import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Request,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  NotificationsService,
  RegisterDeviceTokenDto,
  SendNotificationDto,
} from "./notifications.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { NotificationChannel, NotificationType } from "@orderhub/database";

@ApiTags("notifications")
@ApiBearerAuth()
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // POST /v1/notifications/device-tokens
  @Post("device-tokens")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Register a device token for push notifications" })
  registerDeviceToken(
    @Body() dto: RegisterDeviceTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notifications.registerDeviceToken(user.userId, user.tenantId, dto);
  }

  // DELETE /v1/notifications/device-tokens/:token
  @Delete("device-tokens/:token")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Unregister a device token" })
  unregisterDeviceToken(
    @Param("token") token: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notifications.unregisterDeviceToken(user.userId, token);
  }

  // GET /v1/notifications/history
  @Get("history")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Get notification history for tenant (MANAGER+)" })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query("userId") userId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.notifications.getNotificationHistory(user.tenantId, {
      userId,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  // POST /v1/notifications/test
  @Post("test")
  @Roles("MANAGER", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send a test notification (MANAGER+)" })
  sendTest(
    @Body()
    body: {
      type?: NotificationType;
      title: string;
      body: string;
      channels: NotificationChannel[];
      userId?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const dto: SendNotificationDto = {
      userId: body.userId ?? user.userId,
      type: body.type ?? NotificationType.SYSTEM,
      title: body.title,
      body: body.body,
      channels: body.channels,
    };
    return this.notifications.send(user.tenantId, dto);
  }
}
