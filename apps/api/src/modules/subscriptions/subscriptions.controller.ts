import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { SubscriptionsService } from "./subscriptions.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Billing is owner-and-admin only. FINANCIAL_AGENT was previously allowed
// here; it was removed on request. Re-add it to this one list if a finance
// user needs to manage cards and invoices — every route below shares it.
const BILLING_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER"] as const;

@ApiTags("subscriptions")
@ApiBearerAuth()
@Controller({ path: "subscriptions", version: "1" })
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: "List subscriptions for the current tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    // Scoped to the caller's accessible locations (admins see all) so an OWNER
    // or FINANCIAL_AGENT only sees their own location's subscription.
    return this.subs.listForTenant(user.tenantId, user.userId, user.role);
  }

  @Get("locations/:locationId")
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: "Get one location's subscription" })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.getForLocation(user.tenantId, locationId, user.userId, user.role);
  }

  @Post("locations/:locationId/plan")
  @Roles(...BILLING_ROLES)
  @ApiOperation({
    summary:
      "Set or update the monthly amount. First call returns a Stripe Checkout URL.",
  })
  setPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: { monthlyAmountPence: number; billingEmail?: string },
  ) {
    return this.subs.setPlan(
      user.tenantId,
      locationId,
      body.monthlyAmountPence,
      body.billingEmail,
      user.userId,
      user.role,
    );
  }

  @Post("locations/:locationId/portal")
  @Roles(...BILLING_ROLES)
  @ApiOperation({
    summary: "Open the Stripe Customer Portal (card, invoices, PDFs).",
  })
  portal(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.createPortalSession(user.tenantId, locationId, user.userId, user.role);
  }

  @Post("locations/:locationId/restart-checkout")
  @Roles(...BILLING_ROLES)
  @ApiOperation({
    summary: "Re-open the Stripe Checkout to finish an incomplete subscription",
  })
  restart(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.restartCheckout(user.tenantId, locationId, user.userId, user.role);
  }

  @Delete("locations/:locationId")
  @Roles(...BILLING_ROLES)
  @ApiOperation({
    summary: "Cancel — defaults to end-of-period; ?immediate=1 cancels now",
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Query("immediate") immediate?: string,
  ) {
    return this.subs.cancel(
      user.tenantId,
      locationId,
      immediate === "1" || immediate === "true",
      user.userId,
      user.role,
    );
  }

  @Get("locations/:locationId/invoices")
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: "List Stripe-side invoices for this subscription" })
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.listInvoices(user.tenantId, locationId, user.userId, user.role);
  }
}
