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
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("delivery-zones")
@ApiBearerAuth()
@BillingExempt() // POS lookup must work even when billing is misconfigured
@Controller({ path: "delivery-zones", version: "1" })
export class DeliveryZonesController {
  constructor(private readonly zones: DeliveryZonesService) {}

  @Get()
  @ApiOperation({ summary: "List delivery zones for a location" })
  @ApiQuery({ name: "locationId", required: true })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.zones.listForLocation(user.tenantId, locationId);
  }

  @Get("lookup")
  @ApiOperation({ summary: "Look up delivery fee for postcode at location" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "postcode", required: true })
  lookup(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("postcode") postcode: string,
  ) {
    return this.zones.lookup(user.tenantId, locationId, postcode);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create delivery zone" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      locationId: string;
      postcodePrefix: string;
      fee: number;
      minOrderValue?: number;
      isActive?: boolean;
    },
  ) {
    return this.zones.create(user.tenantId, body);
  }

  @Patch(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update delivery zone" })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body()
    body: {
      postcodePrefix?: string;
      fee?: number;
      minOrderValue?: number | null;
      isActive?: boolean;
    },
  ) {
    return this.zones.update(user.tenantId, id, body);
  }

  @Delete(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete delivery zone" })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.zones.remove(user.tenantId, id);
  }
}
