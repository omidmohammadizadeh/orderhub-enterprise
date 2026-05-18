import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  IntegrationsService,
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from "./integrations.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("integrations")
@ApiBearerAuth()
@Controller({ path: "integrations", version: "1" })
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @ApiOperation({ summary: "List integrations for a location" })
  findAll(
    @Query("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.findByLocation(locationId, user.tenantId);
  }

  @Get("health")
  @ApiOperation({ summary: "Integration health status across all locations" })
  healthCheck(@CurrentUser() user: AuthenticatedUser) {
    return this.integrations.healthCheck(user.tenantId);
  }

  @Get(":integrationId")
  @ApiOperation({ summary: "Get integration details" })
  findOne(
    @Param("integrationId") integrationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.findOne(integrationId, user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create / activate an integration" })
  create(
    @Body() dto: CreateIntegrationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.create(user.tenantId, dto);
  }

  @Patch(":integrationId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update integration credentials or status" })
  update(
    @Param("integrationId") integrationId: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.update(integrationId, user.tenantId, dto);
  }

  @Post(":integrationId/retry")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Retry failed sync" })
  retrySync(
    @Param("integrationId") integrationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.retrySync(integrationId, user.tenantId);
  }

  @Delete(":integrationId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Disconnect / soft-delete integration" })
  remove(
    @Param("integrationId") integrationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integrations.remove(integrationId, user.tenantId);
  }
}
