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
