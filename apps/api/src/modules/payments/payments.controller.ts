import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import {
  PaymentsService,
  CreatePaymentIntentDto,
  CreateRefundDto,
  GetLedgerOpts,
} from "./payments.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments", version: "1" })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // POST /v1/payments/intent
  @Post("intent")
  @ApiOperation({ summary: "Create a Stripe PaymentIntent and persist a Payment record" })
  createPaymentIntent(
    @Body() body: { orderId: string } & CreatePaymentIntentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { orderId, ...dto } = body;
    return this.payments.createPaymentIntent(user.tenantId, orderId, dto);
  }

  // POST /v1/payments/webhook  — @Public so JwtAuthGuard is skipped
  @Post("webhook")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Stripe webhook endpoint (raw body required)" })
  handleWebhook(
    @Req() req: Request,
    @Headers("stripe-signature") signature: string,
  ) {
    // Express should be configured with express.raw() for this route upstream.
    // If body is already a Buffer we use it directly; otherwise we serialise.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));
    return this.payments.handleStripeWebhook(rawBody, signature ?? "");
  }

  // GET /v1/payments/orders/:orderId
  @Get("orders/:orderId")
  @ApiOperation({ summary: "Get all payments and refunds for an order" })
  getPaymentsByOrder(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.getPaymentsByOrder(orderId, user.tenantId);
  }

  // POST /v1/payments/:paymentId/refund
  @Post(":paymentId/refund")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Issue a refund against a succeeded payment" })
  createRefund(
    @Param("paymentId") paymentId: string,
    @Body() dto: CreateRefundDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.createRefund(user.tenantId, paymentId, dto);
  }

  // GET /v1/payments/ledger
  @Get("ledger")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Paginated ledger entries for the tenant" })
  getLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const opts: GetLedgerOpts = {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    };
    return this.payments.getLedger(user.tenantId, opts);
  }

  // GET /v1/payments/payouts
  @Get("payouts")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Get Stripe payout history" })
  getPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    return this.payments.getPayoutHistory(
      user.tenantId,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // GET /v1/payments/reconcile?date=YYYY-MM-DD
  @Get("reconcile")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Daily financial reconciliation summary" })
  reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Query("date") date: string,
  ) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = new Date().toISOString().slice(0, 10);
    }
    return this.payments.reconcile(user.tenantId, date);
  }

  // GET /v1/payments/connect/account
  @Get("connect/account")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Get Stripe Connect account for the tenant" })
  getConnectAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.getConnectAccount(user.tenantId);
  }

  // POST /v1/payments/connect/onboard
  @Post("connect/onboard")
  @Roles("TENANT_OWNER")
  @ApiOperation({ summary: "Start Stripe Connect onboarding flow" })
  startOnboarding(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.createConnectOnboardingLink(user.tenantId);
  }

  // ── Phase AP-8 — per-location Connect onboarding ─────────────────

  // POST /v1/payments/connect/locations/:locationId/onboard
  // Returns a Stripe-hosted onboarding URL the operator opens in a
  // new tab. On the location's first call, this creates the Express
  // Connect account and stamps the acct_… ID onto the Location row
  // so resolveConnectAccount finds it on the very next checkout.
  @Post("connect/locations/:locationId/onboard")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Start Stripe Connect onboarding for a location" })
  startLocationOnboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.payments.createLocationConnectOnboardingLink(
      user.tenantId,
      locationId,
    );
  }

  // GET /v1/payments/connect/locations/:locationId/status
  // Lets the Location settings UI render the connection state +
  // capability flags (chargesEnabled / payoutsEnabled / done).
  @Get("connect/locations/:locationId/status")
  @Roles("MANAGER", "TENANT_OWNER", "CASHIER", "KITCHEN_STAFF")
  @ApiOperation({ summary: "Get a location's Stripe Connect status" })
  getLocationConnectStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
  ) {
    return this.payments.getLocationConnectStatus(user.tenantId, locationId);
  }

  // ── Phase AW-30 — per-brand embedded onboarding endpoints ──────────

  // GET /v1/payments/connect/brands — one row per brand with status.
  @Get("connect/brands")
  @Roles("MANAGER", "TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "List Connect status for every brand" })
  listBrandConnectStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.listBrandConnectStatus(user.tenantId);
  }

  // POST /v1/payments/connect/brands/:brandId/onboarding-session
  @Post("connect/brands/:brandId/onboarding-session")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Open embedded onboarding for a brand" })
  brandOnboardingSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param("brandId") brandId: string,
  ) {
    return this.payments.createBrandOnboardingSession(
      user.tenantId,
      brandId,
      user.userId,
    );
  }

  // POST /v1/payments/connect/brands/:brandId/management-session
  @Post("connect/brands/:brandId/management-session")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Open embedded management panel for a brand" })
  brandManagementSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param("brandId") brandId: string,
  ) {
    return this.payments.createBrandManagementSession(
      user.tenantId,
      brandId,
      user.userId,
    );
  }

  // POST /v1/payments/connect/brands/:brandId/refresh
  // Pulls fresh capability flags from Stripe and updates our DB row.
  @Post("connect/brands/:brandId/refresh")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Refresh a brand's Connect status from Stripe" })
  refreshBrandConnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("brandId") brandId: string,
  ) {
    return this.payments.refreshBrandConnectStatus(user.tenantId, brandId);
  }
}
