import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ReviewsService, type SubmitReviewDto } from "./reviews.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Replying publicly on the brand's behalf is a manager-tier act, so the write
// endpoints carry both legacy and Team-Role names (as elsewhere in the API).
const MANAGE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("reviews")
@Controller("reviews")
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  // ── Public (storefront) ─────────────────────────────────────────────────

  @Public()
  @Post("public")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Leave a review for a completed order" })
  submit(@Body() dto: SubmitReviewDto) {
    return this.reviews.submit(dto);
  }

  @Public()
  @Get("public")
  @ApiOperation({ summary: "Published reviews + rating summary for a storefront" })
  publicList(
    @Query("brandId") brandId?: string,
    @Query("locationId") locationId?: string,
    @Query("rating") rating?: string,
    @Query("limit") limit?: string,
  ) {
    return this.reviews.publicList({
      brandId,
      locationId,
      rating: rating ? parseInt(rating, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Public()
  @Post("public/reviewed")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Which of these orders already have a review" })
  async reviewed(@Body() body: { orderIds?: string[] }) {
    const ids = Array.isArray(body?.orderIds) ? body.orderIds.slice(0, 100) : [];
    return { orderIds: await this.reviews.reviewedOrderIds(ids) };
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "List reviews for the tenant" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("brandId") brandId?: string,
    @Query("rating") rating?: string,
    @Query("limit") limit?: string,
  ) {
    return this.reviews.list(user, {
      locationId,
      brandId,
      rating: rating ? parseInt(rating, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch(":id/reply")
  @Roles(...MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Publish a public reply to a review" })
  reply(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { reply: string },
  ) {
    return this.reviews.reply(id, user, body?.reply);
  }

  @Patch(":id/status")
  @Roles(...MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Hide or restore a review" })
  setStatus(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { status: string },
  ) {
    return this.reviews.setStatus(id, user, body?.status);
  }
}
