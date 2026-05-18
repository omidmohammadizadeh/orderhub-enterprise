import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { BrandingService, UpsertBrandingDto } from "./branding.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("branding")
@ApiBearerAuth()
@Controller({ path: "branding", version: "1" })
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get tenant branding and custom domains" })
  getBranding(@CurrentUser() user: AuthenticatedUser) {
    return this.branding.getBranding(user.tenantId);
  }

  @Put()
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create or update tenant branding" })
  upsertBranding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertBrandingDto,
  ) {
    return this.branding.upsertBranding(user.tenantId, dto);
  }

  @Get("public/:tenantSlug")
  @Public()
  @ApiOperation({ summary: "Get public branding for a tenant (no auth required)" })
  getPublicBranding(@Param("tenantSlug") tenantSlug: string) {
    return this.branding.getPublicBranding(tenantSlug);
  }

  @Post("domains")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add a custom domain" })
  addDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { domain: string },
  ) {
    return this.branding.addCustomDomain(user.tenantId, body.domain);
  }

  @Post("domains/:id/verify")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify domain DNS TXT record" })
  verifyDomain(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branding.verifyDomain(id, user.tenantId);
  }

  @Delete("domains/:id")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a custom domain" })
  removeDomain(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branding.removeDomain(id, user.tenantId);
  }
}
