import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import {
  CustomerJwtGuard,
  CurrentCustomer,
} from "../customer-auth/customer.decorator";
import { LoyaltyService } from "./loyalty.service";
import { ReferralService } from "./referral.service";

// Two audiences, two very different sets of rules.
//
// The OPERATOR routes configure a location's card and are staff-only. The
// CUSTOMER routes read and spend one card — the customer's own — and are
// authenticated by the storefront's customer token, never the dashboard's.
// Mixing the two guards is what put an authenticated call on a public page
// earlier this week and signed customers out.
@ApiTags("loyalty")
@Controller({ path: "loyalty", version: "1" })
export class LoyaltyController {
  constructor(
    private readonly loyalty: LoyaltyService,
    private readonly referrals: ReferralService,
  ) {}

  // ── Operator ─────────────────────────────────────────────────────────────

  @Get("cards/:locationId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "This location's loyalty card settings" })
  getCard(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.loyalty.getCard(user.tenantId, locationId);
  }

  @Put("cards/:locationId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Save this location's loyalty card" })
  saveCard(
    @Param("locationId") locationId: string,
    @Body()
    body: {
      isActive?: boolean;
      stampsRequired?: number;
      minimumSpend?: number | null;
      rewardItemId?: string | null;
      rewardLabel?: string;
      rewardExpiryDays?: number | null;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.loyalty.upsertCard(user.tenantId, locationId, body);
  }

  // ── Customer ─────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("card")
  @ApiOperation({ summary: "My card at this location — stamps and rewards" })
  myCard(
    @Query("locationId") locationId: string,
    @CurrentCustomer() customer: { id: string },
  ) {
    return this.loyalty.cardFor(customer.id, locationId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("claimable")
  @ApiOperation({ summary: "Rewards I can spend here right now" })
  claimable(
    @Query("locationId") locationId: string,
    @CurrentCustomer() customer: { id: string },
  ) {
    return this.loyalty.claimableAt(customer.id, locationId);
  }

  // ── Referrals ────────────────────────────────────────────────────────────

  @Get("referrals/:locationId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "This location's refer-a-friend settings" })
  getProgram(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.referrals.getProgram(user.tenantId, locationId);
  }

  @Put("referrals/:locationId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Save this location's refer-a-friend settings" })
  saveProgram(
    @Param("locationId") locationId: string,
    @Body()
    body: {
      isActive?: boolean;
      referrerAmount?: number;
      friendAmount?: number;
      minimumSpend?: number | null;
      maxPerCustomer?: number;
      rewardExpiryDays?: number | null;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.referrals.upsertProgram(user.tenantId, locationId, body);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("referral-code")
  @ApiOperation({ summary: "My code for this shop, minted on first ask" })
  myCode(
    @Query("locationId") locationId: string,
    @CurrentCustomer() customer: { id: string },
  ) {
    return this.referrals.myCode(customer.id, locationId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("referral-code/claim")
  @ApiOperation({ summary: "Use a friend's code" })
  claimCode(
    @Body() body: { locationId: string; code: string },
    @CurrentCustomer() customer: { id: string },
  ) {
    return this.referrals.claimCode({
      customerAccountId: customer.id,
      locationId: body.locationId,
      code: body.code,
    });
  }
}
