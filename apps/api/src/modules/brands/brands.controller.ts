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
import { BrandsService, CreateBrandDto, UpdateBrandDto } from "./brands.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("brands")
@ApiBearerAuth()
@Controller({ path: "brands", version: "1" })
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get()
  @ApiOperation({ summary: "List brands for the tenant (optional locationId scope)" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    // Phase AR — tenant-wide roles see every brand; everyone else
    // gets narrowed by UserBrand + brands at their UserLocation set.
    const TENANT_WIDE_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);
    const userId = TENANT_WIDE_ROLES.has(user.role as string)
      ? undefined
      : user.userId;
    return this.brands.findAll(user.tenantId, locationId, userId);
  }

  @Get(":brandId")
  @ApiOperation({ summary: "Get brand details with locations" })
  findOne(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.brands.findOne(brandId, user.tenantId);
  }

  @Post()
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a brand" })
  create(
    @Body() dto: CreateBrandDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.brands.create(user.tenantId, dto);
  }

  @Patch(":brandId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update brand" })
  update(
    @Param("brandId") brandId: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.brands.update(brandId, user.tenantId, dto);
  }

  @Delete(":brandId")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete brand" })
  remove(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.brands.remove(brandId, user.tenantId);
  }
}
