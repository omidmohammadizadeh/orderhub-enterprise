import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  MobileService,
  RegisterSessionDto,
  RegisterWebPushDto,
} from "./mobile.service";
import { APP_CAPABILITIES } from "./mobile-api-contract";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("mobile")
@ApiBearerAuth()
@Controller({ path: "mobile", version: "1" })
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  // ── SESSIONS ──────────────────────────────────────────────────────────────────

  @Post("sessions")
  @ApiOperation({ summary: "Register or refresh a mobile session" })
  registerSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterSessionDto,
  ) {
    return this.mobile.registerSession(user.userId, user.tenantId, dto);
  }

  @Post("sessions/heartbeat")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send session heartbeat and optionally update FCM token" })
  heartbeat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { deviceId: string; appId: string; fcmToken?: string },
  ) {
    return this.mobile.heartbeat(user.userId, body.deviceId, body.appId, body.fcmToken);
  }

  @Get("sessions")
  @ApiOperation({ summary: "List all active mobile sessions for current user" })
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.mobile.listSessions(user.userId);
  }

  @Delete("sessions/:deviceId/:appId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke a mobile session" })
  revokeSession(
    @Param("deviceId") deviceId: string,
    @Param("appId") appId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.mobile.revokeSession(user.userId, deviceId, appId);
  }

  // ── WEB PUSH ──────────────────────────────────────────────────────────────────

  @Post("web-push/subscribe")
  @ApiOperation({ summary: "Register a web push subscription" })
  registerWebPush(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterWebPushDto,
  ) {
    return this.mobile.registerWebPush(user.userId, user.tenantId, dto);
  }

  @Delete("web-push/unsubscribe")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Unregister a web push subscription by endpoint" })
  unregisterWebPush(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { endpoint: string },
  ) {
    return this.mobile.unregisterWebPush(user.userId, body.endpoint);
  }

  // ── CONTRACTS ─────────────────────────────────────────────────────────────────

  @Get("contracts")
  @Public()
  @ApiOperation({ summary: "Get mobile app capability contracts (public)" })
  getContracts() {
    return { apps: APP_CAPABILITIES };
  }
}
