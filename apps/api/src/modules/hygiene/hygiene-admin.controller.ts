import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { LocationHygieneService } from "./location-hygiene.service";

class SetHygieneEnabledDto {
  @IsBoolean() enabled!: boolean;
}

// Admin Dashboard → Food hygiene. One switch per location for the storefront
// FSA badge, so the platform team can turn it on across shops without opening
// each location's settings.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/hygiene", version: "1" })
export class HygieneAdminController {
  constructor(private readonly hygiene: LocationHygieneService) {}

  @Get()
  @ApiOperation({ summary: "Every location's food hygiene badge: linked FSA record, rating, shown or not" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.hygiene.listForTenant(user.tenantId);
  }

  // Two segments, declared before ":locationId", so the param route can't take it.
  @Post("link-all")
  @ApiOperation({ summary: "Find the FSA record of every unlinked location (found ones start hidden)" })
  linkAll(@CurrentUser() user: AuthenticatedUser) {
    return this.hygiene.linkAll(user.tenantId);
  }

  @Put(":locationId")
  @ApiOperation({ summary: "Show or hide one location's hygiene badge (finds its FSA record if needed)" })
  setEnabled(
    @Param("locationId") locationId: string,
    @Body() dto: SetHygieneEnabledDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hygiene.setEnabled(locationId, user.tenantId, dto.enabled);
  }

  @Post(":locationId/refresh")
  @ApiOperation({ summary: "Re-check one location's rating with the FSA now" })
  async refresh(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.hygiene.refresh(locationId, user.tenantId);
    return (await this.hygiene.listForTenant(user.tenantId)).find((r) => r.locationId === locationId);
  }
}
