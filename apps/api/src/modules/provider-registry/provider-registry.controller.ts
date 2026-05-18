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
  ProviderRegistryService,
  UpsertWebhookRouteDto,
} from "./provider-registry.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import type { ProviderCategory } from "@orderhub/database";

@ApiTags("providers")
@ApiBearerAuth()
@Controller({ path: "providers", version: "1" })
export class ProviderRegistryController {
  constructor(private readonly registry: ProviderRegistryService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: "List all registered providers" })
  getAllProviders() {
    return this.registry.getAllProviders();
  }

  @Get("matrix")
  @Public()
  @ApiOperation({ summary: "Provider capability matrix" })
  getCapabilityMatrix() {
    return this.registry.getCapabilityMatrix();
  }

  @Get("routes")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "List webhook routes for this tenant" })
  getRoutes(@CurrentUser() user: AuthenticatedUser) {
    return this.registry.getWebhookRoutes(user.tenantId);
  }

  @Post("routes")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create or update a webhook route" })
  upsertRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertWebhookRouteDto,
  ) {
    return this.registry.upsertWebhookRoute(user.tenantId, dto);
  }

  @Delete("routes/:id")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a webhook route" })
  removeRoute(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.registry.removeWebhookRoute(id, user.tenantId);
  }

  @Get(":key")
  @Public()
  @ApiOperation({ summary: "Get a single provider by key" })
  getProvider(@Param("key") key: string) {
    return this.registry.getProvider(key);
  }
}
