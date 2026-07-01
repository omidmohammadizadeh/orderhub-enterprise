import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Get,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DeliverooConnectionService } from "./deliveroo-connection.service";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";

// Phase BA-2 — per-brand Deliveroo connect + store control.
@ApiTags("deliveroo")
@ApiBearerAuth()
@Controller({ path: "integrations/deliveroo", version: "1" })
export class DeliverooController {
  constructor(private readonly service: DeliverooConnectionService) {}

  @Post("connect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connect a brand's Deliveroo store (Site ID → Brand ID)" })
  connect(
    @Body()
    body: {
      brandId: string;
      locationId: string;
      storeId: string;
      deliverooBrandId?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.connect(user.tenantId, body);
  }

  @Post("fetch-brand-id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resolve a Deliveroo Brand ID from a Site ID" })
  async fetchBrandId(@Body() body: { storeId: string }) {
    return { deliverooBrandId: await this.service.fetchBrandId(body.storeId) };
  }

  @Post(":connectionId/disconnect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disconnect a Deliveroo store" })
  disconnect(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.disconnect(user.tenantId, connectionId);
  }

  @Get(":connectionId/status")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get the Deliveroo store OPEN/CLOSED status" })
  status(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.storeStatus(user.tenantId, connectionId);
  }

  @Post(":connectionId/pause")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Pause the Deliveroo store (CLOSED)" })
  pause(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.setStoreOpen(user.tenantId, connectionId, false);
  }

  @Post(":connectionId/resume")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume the Deliveroo store (OPEN)" })
  resume(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.setStoreOpen(user.tenantId, connectionId, true);
  }

  @Post(":connectionId/publish-hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push opening hours + prep time to Deliveroo" })
  publishHours(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.publishHours(user.tenantId, connectionId);
  }
}
