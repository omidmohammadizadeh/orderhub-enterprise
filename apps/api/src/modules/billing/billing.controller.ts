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
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  BillingService,
  CreateSubscriptionDto,
  UpdateSubscriptionDto,
  GenerateInvoiceDto,
} from "./billing.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("billing")
@ApiBearerAuth()
@Controller({ path: "billing", version: "1" })
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  // GET /v1/billing/plans  — public so unauthenticated users can browse plans
  @Get("plans")
  @Public()
  @ApiOperation({ summary: "List all active subscription plans" })
  getPlans() {
    return this.billing.getPlans();
  }

  // GET /v1/billing/subscription
  @Get("subscription")
  @ApiOperation({ summary: "Get current tenant subscription with plan details" })
  getSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getSubscription(user.tenantId);
  }

  // POST /v1/billing/subscription
  @Post("subscription")
  @ApiOperation({ summary: "Create a new tenant subscription" })
  createSubscription(
    @Body() dto: CreateSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.createSubscription(user.tenantId, dto);
  }

  // PATCH /v1/billing/subscription  — upgrade or downgrade plan
  @Patch("subscription")
  @Roles("TENANT_OWNER")
  @ApiOperation({ summary: "Upgrade or downgrade the active subscription plan" })
  updateSubscription(
    @Body() dto: UpdateSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.updateSubscription(user.tenantId, dto);
  }

  // DELETE /v1/billing/subscription — marks cancelAtPeriodEnd=true
  @Delete("subscription")
  @Roles("TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel subscription at end of current billing period" })
  cancelSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.cancelSubscription(user.tenantId);
  }

  // GET /v1/billing/invoices
  @Get("invoices")
  @ApiOperation({ summary: "List invoices for the tenant" })
  getInvoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    return this.billing.getInvoices(
      user.tenantId,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // GET /v1/billing/invoices/:id
  @Get("invoices/:id")
  @ApiOperation({ summary: "Get a single invoice with line items" })
  getInvoice(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.getInvoice(id, user.tenantId);
  }

  // POST /v1/billing/invoices — generate a manual invoice
  @Post("invoices")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Manually generate an invoice for a subscription" })
  generateInvoice(
    @Body() body: { subscriptionId: string } & GenerateInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { subscriptionId, ...dto } = body;
    return this.billing.generateInvoice(user.tenantId, subscriptionId, dto);
  }

  // GET /v1/billing/features/:featureKey — check plan feature access
  @Get("features/:featureKey")
  @ApiOperation({ summary: "Check if the current plan includes a feature" })
  checkFeature(
    @Param("featureKey") featureKey: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing
      .checkFeatureAccess(user.tenantId, featureKey)
      .then((hasAccess) => ({ featureKey, hasAccess }));
  }

  // ── Phase R: Tenant billing status ────────────────────────────────────────

  // GET /v1/billing/status — tenant-scoped billing overview (no Stripe IDs exposed)
  @Get("status")
  @ApiOperation({ summary: "Current tenant billing status, plan, and recent invoices" })
  getTenantBillingStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getTenantBillingStatus(user.tenantId);
  }

  // ── Phase R: Stripe Checkout & Portal ──────────────────────────────────────

  // POST /v1/billing/checkout — start a Stripe Checkout session
  @Post("checkout")
  @Roles("TENANT_OWNER")
  @ApiOperation({ summary: "Create a Stripe Checkout session to subscribe or upgrade" })
  createCheckout(
    @Body() body: { planId: string; successUrl: string; cancelUrl: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.createCheckoutSession(user.tenantId, {
      planId: body.planId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      stripeService: (this.billing as any).stripeService,
    });
  }

  // POST /v1/billing/portal — open Stripe Billing Portal
  @Post("portal")
  @Roles("TENANT_OWNER")
  @ApiOperation({ summary: "Create a Stripe Billing Portal session to manage payment method" })
  createPortal(
    @Body() body: { returnUrl: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.createPortalSession(user.tenantId, {
      returnUrl: body.returnUrl,
      stripeService: (this.billing as any).stripeService,
    });
  }

  // ── Phase R: Admin billing overview (PLATFORM_ADMIN only) ─────────────────

  // GET /v1/billing/admin/overview — all tenant subscriptions
  @Get("admin/overview")
  @Roles("PLATFORM_ADMIN")
  @ApiOperation({ summary: "Admin: all tenant subscription statuses — PLATFORM_ADMIN only" })
  getAdminBillingOverview() {
    return this.billing.getAdminBillingOverview();
  }
}
