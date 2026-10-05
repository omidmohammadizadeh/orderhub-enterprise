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

// Same people who run Marketing. OWNER is new: a shop owner manages their own
// shop's codes; account-wide codes stay with tenant-wide admins.
const PROMO_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "DARK_KITCHEN_MANAGER", "MANAGER"] as const;

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

  // ── Marketing → Promo codes page ─────────────────────────────────────────

  @Get("overview")
  @Roles(...PROMO_ROLES)
  @ApiOperation({ summary: "Codes with status, orders/sales/discount, and the emails that use them" })
  overview(@CurrentUser() user: AuthenticatedUser, @Query("locationId") locationId?: string) {
    return this.service.overview(user.tenantId, user, locationId || null);
  }

  @Get(":id/orders")
  @Roles(...PROMO_ROLES)
  @ApiOperation({ summary: "The latest orders that used a code" })
  orders(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.service.recentOrders(user.tenantId, user, id);
  }

  // Create / edit / delete: a shop-scoped owner or manager may only touch
  // codes limited to their own shops (enforced in the service).

  @Post()
  @Roles(...PROMO_ROLES)
  @ApiOperation({ summary: "Create promo code" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromoCodeDto,
  ) {
    return this.service.createFor(user.tenantId, user, dto);
  }

  @Patch(":id")
  @Roles(...PROMO_ROLES)
  @ApiOperation({ summary: "Update promo code" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdatePromoCodeDto,
  ) {
    return this.service.updateFor(user.tenantId, user, id, dto);
  }

  @Delete(":id")
  @Roles(...PROMO_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.service.removeFor(user.tenantId, user, id);
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
