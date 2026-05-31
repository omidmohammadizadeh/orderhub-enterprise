import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import {
  BrandConnectionsService,
  UpsertConnectionDto,
} from "./brand-connections.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("brand-connections")
@ApiBearerAuth()
@Controller({ path: "brand-connections", version: "1" })
export class BrandConnectionsController {
  constructor(private readonly service: BrandConnectionsService) {}

  @Get()
  @ApiOperation({ summary: "List connections (by brand or location)" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
    @Query("locationId") locationId?: string,
  ) {
    if (brandId) return this.service.listForBrand(user.tenantId, brandId);
    if (locationId) return this.service.listForLocation(user.tenantId, locationId);
    return [];
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Upsert a brand-platform connection" })
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertConnectionDto,
  ) {
    return this.service.upsert(user.tenantId, dto);
  }

  @Patch(":id/disconnect")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Disconnect (reset to not_connected)" })
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.service.disconnect(user.tenantId, id);
  }
}
