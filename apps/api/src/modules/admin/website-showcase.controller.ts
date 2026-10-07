import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";
import { WebsiteShowcaseService } from "./website-showcase.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

class SetShowcaseDto {
  @IsBoolean() showcaseOnWebsite!: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(9999) showcaseOrder?: number | null;
}

// Admin Dashboard → Website showcase.
//
// PLATFORM_ADMIN only, not TENANT_OWNER: this puts a merchant's name on our
// marketing site, so it's our decision, and a tenant must not be able to see
// (or feature) other tenants' brands.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/website-showcase", version: "1" })
export class WebsiteShowcaseController {
  constructor(private readonly showcase: WebsiteShowcaseService) {}

  @Get()
  @ApiOperation({ summary: "Every brand, with whether it's on the homepage wall" })
  list() {
    return this.showcase.list();
  }

  @Post("feature-live")
  @ApiOperation({ summary: "Feature every brand with a logo and a real order in 30 days" })
  featureLive(@CurrentUser() user: AuthenticatedUser) {
    return this.showcase.featureAllLive(user.userId);
  }

  @Put(":brandId")
  @ApiOperation({ summary: "Show or hide one brand on the homepage wall" })
  set(
    @Param("brandId") brandId: string,
    @Body() dto: SetShowcaseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.showcase.set(brandId, dto.showcaseOnWebsite, dto.showcaseOrder, user.userId);
  }
}

// The homepage reads this server-side. Its own controller (not a route on
// `brands`) so no `brands/:brandId` handler can swallow the path.
@ApiTags("Public")
@Controller({ path: "public/website-showcase", version: "1" })
export class PublicWebsiteShowcaseController {
  constructor(private readonly showcase: WebsiteShowcaseService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Brands featured on the marketing homepage" })
  list() {
    return this.showcase.publicList();
  }
}
