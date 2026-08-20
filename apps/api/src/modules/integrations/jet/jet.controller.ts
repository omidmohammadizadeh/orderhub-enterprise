import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JetConnectionService } from "./jet-connection.service";
import { JetClientService } from "./jet-client.service";
import { JetCredentialResolver } from "./jet-credential.resolver";
import { JetStoreStatusService } from "./jet-store-status.service";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";

// Phase JE-0 — Just Eat (JET Connect) connection management.
//
// Every route is scoped by the caller's tenant: the service resolves the
// brand and location against `user.tenantId` before touching a connection, so
// a connection id from another tenant 404s rather than leaking.
@ApiTags("jet")
@ApiBearerAuth()
@Controller({ path: "integrations/jet", version: "1" })
export class JetController {
  constructor(
    private readonly connections: JetConnectionService,
    private readonly client: JetClientService,
    private readonly credentials: JetCredentialResolver,
    private readonly storeStatus: JetStoreStatusService,
  ) {}

  @Post("connect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connect a brand's Just Eat restaurant" })
  connect(
    @Body()
    body: {
      brandId: string;
      locationId: string;
      posLocationId: string;
      restaurantReference?: string;
      brandSlug?: string;
      country?: string;
      menuKey?: string;
      orderKey?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.connect(user.tenantId, body);
  }

  @Get("connections")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "List this tenant's Just Eat connections" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
  ) {
    return this.connections.list(user.tenantId, brandId);
  }

  @Get(":connectionId/health")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Key resolution + last-order health for one restaurant" })
  health(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.health(user.tenantId, connectionId);
  }

  @Post(":connectionId/disconnect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disconnect a Just Eat restaurant" })
  disconnect(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.disconnect(user.tenantId, connectionId);
  }

  @Post(":connectionId/pause")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Take the Just Eat restaurant offline. Without `onlineAt` this is INDEFINITE — the shop stays off Just Eat until it is resumed.",
  })
  pause(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { onlineAt?: string },
  ) {
    const onlineAt = body?.onlineAt ? new Date(body.onlineAt) : null;
    return this.storeStatus.setStoreOnline(user.tenantId, connectionId, false, {
      onlineAt: onlineAt && !Number.isNaN(onlineAt.getTime()) ? onlineAt : null,
    });
  }

  @Post(":connectionId/resume")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bring the Just Eat restaurant back online" })
  resume(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeStatus.setStoreOnline(user.tenantId, connectionId, true);
  }

  @Post(":connectionId/publish-hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Push this location's opening hours to Just Eat as Delivery + Collection service times",
  })
  publishHours(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storeStatus.publishServiceTimes(user.tenantId, connectionId);
  }

  /**
   * Deployment probe, mirroring the Uber Eats and HubRise ones.
   *
   * Public and tenant-free by design: its whole job is answering "is the
   * deployed build configured correctly?" before any restaurant exists, which
   * is exactly when you cannot authenticate. It reports only whether each
   * secret is PRESENT — never a value, never a prefix.
   */
  @Public()
  @Get("health")
  @ApiOperation({ summary: "Public JET configuration probe" })
  probe() {
    return {
      configured: this.client.configured,
      build: process.env.RENDER_GIT_COMMIT ?? null,
      menuKeyConfigured: this.credentials.configured("menu"),
      orderKeyConfigured: this.credentials.configured("order"),
      webhookSignatureEnforced: this.client.webhookSecretConfigured,
      inboundApiKeyEnforced: this.client.inboundApiKeyConfigured,
    };
  }
}
