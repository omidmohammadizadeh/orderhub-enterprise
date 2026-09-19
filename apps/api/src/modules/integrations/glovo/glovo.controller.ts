import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { GlovoClientService } from "./glovo-client.service";
import { GlovoConnectionService } from "./glovo-connection.service";
import { GlovoMenuPublishService } from "./glovo-menu-publish.service";
import { GlovoStoreStatusService } from "./glovo-store-status.service";

// Phase GL-6 — Glovo connection management for the dashboard.
//
// Every authenticated route resolves the connection against the caller's
// tenant before touching it, so another tenant's connection id is a 404.
@ApiTags("glovo")
@ApiBearerAuth()
@Controller({ path: "integrations/glovo", version: "1" })
export class GlovoController {
  constructor(
    private readonly client: GlovoClientService,
    private readonly connections: GlovoConnectionService,
    private readonly menus: GlovoMenuPublishService,
    private readonly storeStatus: GlovoStoreStatusService,
  ) {}

  @Post("connect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connect a brand's Glovo store at a location" })
  connect(
    @Body() body: { brandId: string; locationId: string; storeId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.connect(user.tenantId, body);
  }

  @Get("connections")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  list(@CurrentUser() user: AuthenticatedUser, @Query("brandId") brandId?: string) {
    return this.connections.list(user.tenantId, brandId);
  }

  @Get(":connectionId/health")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  health(@Param("connectionId") connectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.connections.health(user.tenantId, connectionId);
  }

  @Post(":connectionId/disconnect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  disconnect(@Param("connectionId") connectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.connections.disconnect(user.tenantId, connectionId);
  }

  @Post(":connectionId/pause")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Close the Glovo store until `until`. Glovo has no open-ended close, so without `until` it closes for 7 days or until resumed.",
  })
  pause(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { until?: string },
  ) {
    const until = body?.until ? new Date(body.until) : null;
    return this.storeStatus.setOpen(user.tenantId, connectionId, false, {
      until: until && !Number.isNaN(until.getTime()) ? until : null,
    });
  }

  @Post(":connectionId/resume")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  resume(@Param("connectionId") connectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.storeStatus.setOpen(user.tenantId, connectionId, true);
  }

  @Get(":connectionId/closing")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  closing(@Param("connectionId") connectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.storeStatus.getClosing(user.tenantId, connectionId);
  }

  @Post(":connectionId/publish-hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  publishHours() {
    return this.storeStatus.publishHours();
  }

  @Post("menus/:menuId/publish")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Upload a menu to the brand's Glovo store (max 5 a day per store)" })
  publish(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { locationId?: string },
  ) {
    return this.menus.publishMenu({ tenantId: user.tenantId, menuId, locationId: body?.locationId });
  }

  @Get(":connectionId/menu-status")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  menuStatus(@Param("connectionId") connectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.menus.checkStatus(user.tenantId, connectionId);
  }

  /**
   * The menu JSON Glovo fetches after an upload. Public because Glovo cannot
   * log in; the per-publish token in the path is the access check.
   */
  @Public()
  @Get("menu-feed/:connectionId/:token")
  menuFeed(
    @Param("connectionId") connectionId: string,
    @Param("token") token: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.menus.serveFeed({ connectionId, token, authorization });
  }

  /**
   * Deployment probe. Public and tenant-free: it answers "is this build
   * configured?" before any store exists. Presence only — never a value.
   */
  @Public()
  @Get("health")
  probe() {
    return {
      configured: this.client.configured,
      environment: this.client.env,
      apiBase: this.client.baseUrl,
      webhookAuthEnforced: this.client.inboundTokenConfigured,
      build: process.env.RENDER_GIT_COMMIT ?? null,
    };
  }
}
