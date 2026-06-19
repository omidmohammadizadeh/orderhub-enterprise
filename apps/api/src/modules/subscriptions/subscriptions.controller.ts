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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "List subscriptions for the current tenant" })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.listForTenant(user.tenantId);
  }

  @Get("locations/:locationId")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT", "MANAGER")
  @ApiOperation({ summary: "Get one location's subscription" })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.getForLocation(user.tenantId, locationId);
  }

  @Post("locations/:locationId/plan")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
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
    );
  }

  @Post("locations/:locationId/portal")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT", "MANAGER")
  @ApiOperation({
    summary: "Open the Stripe Customer Portal (card, invoices, PDFs).",
  })
  portal(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.createPortalSession(user.tenantId, locationId);
  }

  @Post("locations/:locationId/restart-checkout")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT", "MANAGER")
  @ApiOperation({
    summary: "Re-open the Stripe Checkout to finish an incomplete subscription",
  })
  restart(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.restartCheckout(user.tenantId, locationId);
  }

  @Delete("locations/:locationId")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
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
    );
  }

  @Get("locations/:locationId/invoices")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT", "MANAGER")
  @ApiOperation({ summary: "List Stripe-side invoices for this subscription" })
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.subs.listInvoices(user.tenantId, locationId);
  }
}
