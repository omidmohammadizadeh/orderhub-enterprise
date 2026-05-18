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
import { LocationsService, CreateLocationDto, UpdateLocationDto } from "./locations.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("locations")
@ApiBearerAuth()
@Controller({ path: "locations", version: "1" })
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @ApiOperation({ summary: "List locations for the tenant" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
  ) {
    return this.locations.findAll(user.tenantId, brandId);
  }

  @Get(":locationId")
  @ApiOperation({ summary: "Get location details" })
  findOne(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.findOne(locationId, user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a location" })
  create(
    @Body() dto: CreateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.create(user.tenantId, dto);
  }

  @Patch(":locationId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update location" })
  update(
    @Param("locationId") locationId: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.update(locationId, user.tenantId, dto);
  }

  @Delete(":locationId")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete location" })
  remove(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.remove(locationId, user.tenantId);
  }
}
