// Phase AW-19 — Marketing campaign REST endpoints.

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
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { MarketingService } from "./marketing.service";
import { CreateCampaignDto, UpdateCampaignDto } from "./dto/campaign.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("marketing")
@Controller({ path: "marketing", version: "1" })
export class MarketingController {
  constructor(private readonly svc: MarketingService) {}

  @Get("campaigns")
  @ApiOperation({ summary: "List marketing campaigns for the tenant" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
  ) {
    return this.svc.list({ tenantId: user.tenantId, brandId });
  }

  // Receipt QR offer for marketplace tickets — storefront URL + a live
  // "Scan me to get …" caption for this brand. Used by the tablet's
  // print path.
  @Get("receipt-offer")
  @ApiOperation({ summary: "Storefront QR URL + live offer caption for a brand" })
  receiptOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId: string,
    @Query("locationId") locationId: string,
  ) {
    return this.svc.receiptOffer(user.tenantId, brandId, locationId);
  }

  // Phase MK-INSIGHTS — per-campaign performance (Sales/Orders/New
  // customers) over an optional date window, keyed by campaign id. The
  // Marketing page merges this into the campaign list like Uber's Offers.
  @Get("metrics")
  @ApiOperation({ summary: "Per-campaign performance metrics for a date range" })
  metrics(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.svc.getMetrics({
      tenantId: user.tenantId,
      brandId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get("campaigns/:id")
  @ApiOperation({ summary: "Get a single campaign by id" })
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.findOne(id, user.tenantId);
  }

  @Post("campaigns")
  @ApiOperation({ summary: "Create a marketing campaign" })
  create(
    @Body() dto: CreateCampaignDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.create({
      tenantId: user.tenantId,
      userId: user.userId,
      dto,
    });
  }

  @Patch("campaigns/:id")
  @ApiOperation({ summary: "Update a campaign" })
  update(
    @Param("id") id: string,
    @Body() dto: UpdateCampaignDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.update(id, user.tenantId, dto);
  }

  @Delete("campaigns/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a campaign" })
  remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.remove(id, user.tenantId);
  }
}
