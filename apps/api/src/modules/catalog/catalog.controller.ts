import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { CatalogService } from "./catalog.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Phase AL — Catalog extras controller. Mounted at /api/v1.
// All routes are tenant-scoped via CatalogService.

@ApiTags("catalog")
@ApiBearerAuth()
@Controller({ version: "1" })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Meal Deals ─────────────────────────────────────────────────────────
  @Get("brands/:brandId/meal-deals")
  listMealDeals(@Param("brandId") brandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listMealDeals(brandId, user.tenantId);
  }

  @Post("brands/:brandId/meal-deals")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  createMealDeal(
    @Param("brandId") brandId: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.catalog.createMealDeal(brandId, user.tenantId, body);
  }

  @Patch("meal-deals/:id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  updateMealDeal(
    @Param("id") id: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.catalog.updateMealDeal(id, user.tenantId, body);
  }

  @Delete("meal-deals/:id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  deleteMealDeal(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.catalog.deleteMealDeal(id, user.tenantId);
  }

  // ── Upsell Groups ──────────────────────────────────────────────────────
  @Get("brands/:brandId/upsell-groups")
  listUpsellGroups(@Param("brandId") brandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listUpsellGroups(brandId, user.tenantId);
  }

  @Post("brands/:brandId/upsell-groups")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  createUpsellGroup(
    @Param("brandId") brandId: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.catalog.createUpsellGroup(brandId, user.tenantId, body);
  }

  @Patch("upsell-groups/:id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  updateUpsellGroup(
    @Param("id") id: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.catalog.updateUpsellGroup(id, user.tenantId, body);
  }

  @Delete("upsell-groups/:id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  deleteUpsellGroup(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.catalog.deleteUpsellGroup(id, user.tenantId);
  }
}
