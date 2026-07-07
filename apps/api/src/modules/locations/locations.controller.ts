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
  LocationsService,
  CreateLocationDto,
  UpdateLocationDto,
  OpeningHours,
  buildOnlineOrderingUrl,
} from "./locations.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
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
    // Phase AR — tenant-wide roles (platform admin, tenant owner)
    // see every location; every other role gets narrowed to their
    // UserLocation rows. The service falls back to tenant-wide if a
    // scoped role has no rows yet so a freshly-created OWNER who
    // hasn't been bound to specific locations isn't locked out.
    const TENANT_WIDE_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);
    const userId = TENANT_WIDE_ROLES.has(user.role as string)
      ? undefined
      : user.userId;
    return this.locations.findAll(user.tenantId, brandId, userId);
  }

  @Get(":locationId")
  @ApiOperation({ summary: "Get location details" })
  findOne(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Phase AR — scope settings to the user's accessible locations, same
    // as the switcher list. Tenant-wide roles pass no userId (see all).
    const TENANT_WIDE_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);
    const userId = TENANT_WIDE_ROLES.has(user.role as string)
      ? undefined
      : user.userId;
    return this.locations.findOne(locationId, user.tenantId, userId);
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

  // ── Phase AN extensions ─────────────────────────────────────────────────

  @Get(":locationId/online-url")
  @ApiOperation({ summary: "Customer-facing online ordering URL" })
  async onlineUrl(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const loc = await this.locations.findOne(locationId, user.tenantId);
    return {
      slug: loc.onlineOrderingSlug,
      url: loc.onlineOrderingSlug
        ? buildOnlineOrderingUrl(loc.onlineOrderingSlug)
        : null,
    };
  }

  @Post(":locationId/generate-slug")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Generate a unique online-ordering slug" })
  async generateSlug(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { name?: string },
  ) {
    const loc = await this.locations.findOne(locationId, user.tenantId);
    const slug = await this.locations.generateUniqueSlug(
      user.tenantId,
      body.name ?? loc.name,
      locationId,
    );
    const updated = await this.locations.setSlug(locationId, user.tenantId, slug);
    return {
      slug: updated.onlineOrderingSlug,
      url: updated.onlineOrderingSlug
        ? buildOnlineOrderingUrl(updated.onlineOrderingSlug)
        : null,
    };
  }

  @Get(":locationId/opening-hours")
  @ApiOperation({ summary: "Get opening hours" })
  openingHours(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.getOpeningHours(locationId, user.tenantId);
  }

  @Patch(":locationId/opening-hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Replace opening hours" })
  setHours(
    @Param("locationId") locationId: string,
    @Body() body: OpeningHours,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.setOpeningHours(locationId, user.tenantId, body);
  }

  @Post(":locationId/opening-hours/apply-to")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Apply this location's hours to other locations" })
  applyHoursTo(
    @Param("locationId") locationId: string,
    @Body() body: { locationIds: string[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations
      .copyHoursToLocations(locationId, user.tenantId, body.locationIds)
      .then((count) => ({ applied: count }));
  }

  // ── Public storefront ───────────────────────────────────────────────────
  // Customer-facing: `/order/:slug` on the web hits this. No auth.

  @Public()
  @Get("public/by-slug/:slug")
  @ApiOperation({ summary: "Public storefront lookup by online-ordering slug" })
  publicBySlug(@Param("slug") slug: string) {
    return this.locations.findPublicBySlug(slug);
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
