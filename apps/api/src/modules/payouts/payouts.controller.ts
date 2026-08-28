import { Controller, Get, Post, Query, Body, Param } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { PayoutsService } from "./payouts.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Money the shop has earned. Restricted to the roles that already reach the
// rest of finance — a manager rota'd on for the evening has no business
// reading takings, and certainly none changing where they land.
//
// Every method re-derives scope from the caller inside the service; the role
// list here only decides who may ask at all.
const FINANCE_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "FINANCIAL_AGENT",
] as const;

@ApiTags("payouts")
@ApiBearerAuth()
@Controller({ path: "payouts", version: "1" })
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get("accounts")
  @Roles(...FINANCE_ROLES)
  @ApiOperation({ summary: "Payout accounts this user can see" })
  accounts(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    // `locationId` is the sidebar's shop scope. It can only ever narrow what
    // the caller's own assignments already allow — the service checks it
    // against them rather than taking the browser's word for it.
    return this.payouts.listAccounts(
      user.tenantId,
      user.userId,
      user.role,
      locationId,
    );
  }

  @Get()
  @Roles(...FINANCE_ROLES)
  @ApiOperation({ summary: "Payout history, scoped to the user's locations" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("accountId") accountId?: string,
    @Query("limit") limit?: string,
    @Query("locationId") locationId?: string,
  ) {
    return this.payouts.list(user.tenantId, user.userId, user.role, {
      accountId,
      limit: limit ? parseInt(limit, 10) : undefined,
      locationId,
    });
  }

  @Get("balance")
  @Roles(...FINANCE_ROLES)
  @ApiOperation({ summary: "Live Stripe balance and next payout" })
  balance(
    @CurrentUser() user: AuthenticatedUser,
    @Query("accountId") accountId?: string,
    @Query("locationId") locationId?: string,
  ) {
    return this.payouts.balance(
      user.tenantId,
      user.userId,
      user.role,
      accountId,
      locationId,
    );
  }

  @Get(":payoutId/breakdown")
  @Roles(...FINANCE_ROLES)
  @ApiOperation({ summary: "Which orders and fees made up one payout" })
  breakdown(
    @CurrentUser() user: AuthenticatedUser,
    @Param("payoutId") payoutId: string,
    @Query("accountId") accountId?: string,
    @Query("locationId") locationId?: string,
  ) {
    return this.payouts.breakdown(
      user.tenantId,
      user.userId,
      user.role,
      payoutId,
      accountId,
      locationId,
    );
  }

  // POST, not GET: this mints a single-use credential into the merchant's
  // Stripe dashboard. It must never be something a browser can prefetch or a
  // proxy can cache.
  @Post("dashboard-link")
  @Roles(...FINANCE_ROLES)
  @ApiOperation({ summary: "One-time link to the Stripe Express dashboard" })
  dashboardLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { accountId?: string; locationId?: string },
  ) {
    return this.payouts.dashboardLink(
      user.tenantId,
      user.userId,
      user.role,
      body?.accountId,
      body?.locationId,
    );
  }
}
