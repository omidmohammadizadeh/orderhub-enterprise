import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { DispatchChargingService } from "./dispatch-charging.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

class SetDispatchChargingDto {
  @IsBoolean() waiveWalletCharge!: boolean;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

// Admin Dashboard → Dispatch charging.
//
// PLATFORM_ADMIN only, and deliberately not TENANT_OWNER: this decides whether
// a shop pays its own dispatch fees, so an owner who held it would simply
// switch their billing off.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/dispatch-charging", version: "1" })
export class DispatchChargingController {
  constructor(private readonly charging: DispatchChargingService) {}

  @Get()
  @ApiOperation({ summary: "Dispatch charging for every location in the tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.charging.list(user.tenantId);
  }

  @Get(":locationId")
  @ApiOperation({ summary: "Dispatch charging for one location" })
  get(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.charging.get(user.tenantId, locationId);
  }

  @Put(":locationId")
  @ApiOperation({
    summary:
      "Waive or restore the courier dispatch wallet fee for one location (testing)",
  })
  set(
    @Param("locationId") locationId: string,
    @Body() dto: SetDispatchChargingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.charging.set(
      user.tenantId,
      locationId,
      dto.waiveWalletCharge,
      dto.note,
      { userId: user.userId, role: user.role as string },
    );
  }
}
