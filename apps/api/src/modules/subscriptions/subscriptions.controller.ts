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

@ApiTags("subscriptions")
@ApiBearerAuth()
@Controller({ path: "subscriptions", version: "1" })
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "List subscriptions for the current tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    // Scoped to the caller's accessible locations (admins see all) so an OWNER
    // or FINANCIAL_AGENT only sees their own location's subscription.
    return this.subs.listForTenant(user.tenantId, user.userId, user.role);
  }

  @Get("locations/:locationId")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Get one location's subscription" })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.getForLocation(user.tenantId, locationId, user.userId, user.role);
  }

  @Post("locations/:locationId/plan")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "List Stripe-side invoices for this subscription" })
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.listInvoices(user.tenantId, locationId, user.userId, user.role);
  }
}
