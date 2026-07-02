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
  CustomersService,
  CreateCustomerDto,
  UpdateCustomerDto,
  AddAddressDto,
  ValidatePromoDto,
} from "./customers.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("customers")
@ApiBearerAuth()
@Controller({ path: "customers", version: "1" })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: "List customers with optional search" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.customers.findAll(user.tenantId, {
      search,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  // NB: declared before ":customerId" so "directory" isn't captured as an id.
  @Get("directory")
  @ApiOperation({
    summary:
      "Order-derived customer directory — every customer across channels, filterable by channel + new/returning segment",
  })
  directory(
    @CurrentUser() user: AuthenticatedUser,
    @Query("channel") channel?: string,
    @Query("segment") segment?: string,
    @Query("search") search?: string,
  ) {
    return this.customers.directory(user.tenantId, { channel, segment, search });
  }

  @Get(":customerId")
  @ApiOperation({ summary: "Get customer profile" })
  findOne(
    @Param("customerId") customerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.findOne(customerId, user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a customer manually" })
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.create(user.tenantId, dto);
  }

  @Patch(":customerId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update customer profile" })
  update(
    @Param("customerId") customerId: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.update(customerId, user.tenantId, dto);
  }

  @Get(":customerId/orders")
  @ApiOperation({ summary: "Get customer order history" })
  getOrders(
    @Param("customerId") customerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.customers.getOrderHistory(customerId, user.tenantId, {
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get(":customerId/loyalty")
  @ApiOperation({ summary: "Get customer loyalty account" })
  getLoyalty(
    @Param("customerId") customerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.getLoyalty(customerId, user.tenantId);
  }

  @Post(":customerId/loyalty/adjust")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Manually adjust loyalty points" })
  adjustPoints(
    @Param("customerId") customerId: string,
    @Body() body: { delta: number; reason: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.adjustLoyaltyPoints(customerId, user.tenantId, body.delta, body.reason);
  }

  @Post(":customerId/addresses")
  @ApiOperation({ summary: "Add address to customer" })
  addAddress(
    @Param("customerId") customerId: string,
    @Body() dto: AddAddressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.addAddress(customerId, user.tenantId, dto);
  }

  @Delete(":customerId/addresses/:addressId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove customer address" })
  removeAddress(
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.removeAddress(customerId, addressId, user.tenantId);
  }
}

// ── Promo Codes controller (separate tag) ─────────────────────────────────────
@ApiTags("promo-codes")
@ApiBearerAuth()
@Controller({ path: "promo-codes", version: "1" })
export class PromoCodesController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: "List all promo codes for tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.customers.listPromos(user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a promo code" })
  create(
    @Body() dto: {
      code: string;
      type: string;
      value: number;
      description?: string;
      minOrderValue?: number;
      maxUses?: number;
      expiresAt?: string;
      locationIds?: string[];
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.createPromo(user.tenantId, dto);
  }

  @Post("validate")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate a promo code (public — used during checkout)" })
  validate(@Body() dto: ValidatePromoDto & { tenantId: string }) {
    return this.customers.validatePromo(dto.tenantId, dto);
  }

  @Patch(":promoId/toggle")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Toggle promo code active state" })
  toggle(
    @Param("promoId") promoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.togglePromo(promoId, user.tenantId);
  }
}
