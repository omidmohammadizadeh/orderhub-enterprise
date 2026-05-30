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
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import {
  PromoCodesService,
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
  ValidateInput,
} from "./promo-codes.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("promo-codes")
@ApiBearerAuth()
@BillingExempt()
@Controller({ path: "promo-codes", version: "1" })
export class PromoCodesController {
  constructor(private readonly service: PromoCodesService) {}

  @Get()
  @ApiOperation({ summary: "List promo codes (optionally scoped to a location)" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.service.list(user.tenantId, locationId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create promo code" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromoCodeDto,
  ) {
    return this.service.create(user.tenantId, dto);
  }

  @Patch(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update promo code" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdatePromoCodeDto,
  ) {
    return this.service.update(user.tenantId, id, dto);
  }

  @Delete(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.service.remove(user.tenantId, id);
  }

  @Post("validate")
  @ApiOperation({ summary: "Validate promo code for POS cart" })
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ValidateInput,
  ) {
    return this.service.validate(user.tenantId, body);
  }
}
