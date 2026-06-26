import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  DriverAppService,
  PingDto,
  JobAction,
} from "./driver-app.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// All endpoints are for the Order Hub Driver app — the authenticated user must
// be a DRIVER (admins allowed for testing). Each resolves the current driver.
@ApiTags("driver-app")
@ApiBearerAuth()
@Roles("DRIVER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER")
@Controller({ path: "driver", version: "1" })
export class DriverAppController {
  constructor(private readonly driverApp: DriverAppService) {}

  @Get("me")
  @ApiOperation({ summary: "Current driver profile + presence" })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.driverApp.me(user);
  }

  @Get("my-day")
  @ApiOperation({ summary: "Today's active jobs + history + cash-up summary" })
  myDay(@CurrentUser() user: AuthenticatedUser) {
    return this.driverApp.getMyDay(user);
  }

  @Post("online")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Go online at a location" })
  online(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { locationId?: string },
  ) {
    return this.driverApp.goOnline(user, body?.locationId);
  }

  @Post("offline")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Go offline" })
  offline(@CurrentUser() user: AuthenticatedUser) {
    return this.driverApp.goOffline(user);
  }

  @Post("ping")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Report current GPS location" })
  ping(@CurrentUser() user: AuthenticatedUser, @Body() dto: PingDto) {
    return this.driverApp.ping(user, dto);
  }

  @Post("push-token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Register the Expo push token for job alerts" })
  pushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { token: string },
  ) {
    return this.driverApp.registerPushToken(user, body.token);
  }

  @Post("jobs/:orderId/:action")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Act on an assigned job: accept | start | delivered | skip | cancel",
  })
  jobAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Param("action") action: JobAction,
  ) {
    return this.driverApp.jobAction(user, orderId, action);
  }
}
