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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { DeliveryZonesService } from "./delivery-zones.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles, DELIVERY_PRICING_ROLES } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("delivery-zones")
@ApiBearerAuth()
@BillingExempt() // POS lookup must work even when billing is misconfigured
@Controller({ path: "delivery-zones", version: "1" })
export class DeliveryZonesController {
  constructor(private readonly zones: DeliveryZonesService) {}

  @Get()
  @ApiOperation({ summary: "List delivery zones for a location or brand" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "brandId", required: false })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("brandId") brandId?: string,
  ) {
    if (brandId) return this.zones.listForBrand(user.tenantId, brandId);
    if (locationId) return this.zones.listForLocation(user.tenantId, locationId);
    return [];
  }

  @Get("lookup")
  @ApiOperation({ summary: "Look up the delivery fee for a customer at a location" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "postcode", required: false })
  @ApiQuery({ name: "area", required: false, description: "Gulf: the picked community, e.g. Dubai Marina" })
  @ApiQuery({ name: "lat", required: false })
  @ApiQuery({ name: "lng", required: false })
  lookup(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("postcode") postcode?: string,
    @Query("area") area?: string,
    @Query("lat") lat?: string,
    @Query("lng") lng?: string,
  ) {
    const asNum = (v?: string) => {
      const n = Number(v);
      return v != null && v !== "" && Number.isFinite(n) ? n : undefined;
    };
    return this.zones.lookup(user.tenantId, locationId, {
      postcode,
      area,
      lat: asNum(lat),
      lng: asNum(lng),
    });
  }

  @Post()
  @Roles(...DELIVERY_PRICING_ROLES)
  @ApiOperation({ summary: "Create delivery zone" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      locationId?: string;
      brandId?: string;
      postcodePrefix?: string;
      maxDistanceMiles?: number;
      areaName?: string;
      fee: number;
      minOrderValue?: number;
      isActive?: boolean;
    },
  ) {
    return this.zones.create(user.tenantId, body);
  }

  @Patch(":id")
  @Roles(...DELIVERY_PRICING_ROLES)
  @ApiOperation({ summary: "Update delivery zone" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body()
    body: {
      postcodePrefix?: string;
      maxDistanceMiles?: number | null;
      areaName?: string | null;
      fee?: number;
      minOrderValue?: number | null;
      isActive?: boolean;
    },
  ) {
    return this.zones.update(user.tenantId, id, body);
  }

  @Delete(":id")
  @Roles(...DELIVERY_PRICING_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete delivery zone" })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.zones.remove(user.tenantId, id);
  }
}
