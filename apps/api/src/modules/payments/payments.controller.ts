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
  BadRequestException,
  Logger,
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
import { Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { ReceiptEmailService } from "./receipt-email.service";
import { PayoutsService } from "../payouts/payouts.service";
import { TapService } from "./tap.service";

@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments", version: "1" })
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly receiptEmail: ReceiptEmailService,
    private readonly payouts: PayoutsService,
    private readonly tap: TapService,
  ) {}

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

  /**
   * POST /v1/payments/tap/webhook — Tap's charge/refund notifications.
   *
   * Public, like Stripe's, and for the same reason: the provider posts here
   * unauthenticated. What stands in for auth is the `hashstring` header, an
   * HMAC over six fields of the body signed with our secret key — without
   * verifying it, posting a CAPTURED charge to this URL is all it would take
   * to mark any order paid.
   *
   * Unlike Stripe's, this reads the PARSED body: Tap signs field values, not
   * the raw bytes, so there is nothing to gain from the buffer and one less
   * thing to get wrong about body-parser ordering.
   *
   * Always 200s. Tap retries on any non-2xx, and a charge we can't match to an
   * order is not going to match on the fifth attempt either — it's logged and
   * dropped instead of retried forever.
   */
  @Post("tap/webhook")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Tap Payments webhook (hashstring-signed)" })
  async handleTapWebhook(
    @Body() body: any,
    @Headers("hashstring") hashstring: string,
  ) {
    if (!this.tap.verifyWebhook(body, hashstring)) {
      // Not an error the caller gets to distinguish. A verification failure is
      // either a misconfigured key or someone probing, and telling the two
      // apart in the response helps only the second.
      this.logger.warn(`Tap webhook rejected: bad or missing hashstring (id=${body?.id ?? "?"})`);
      return { received: true };
    }
    await this.tap
      .settleCharge(body)
      .catch((err: any) =>
        this.logger.error(`Tap settleCharge failed for ${body?.id}: ${err.message}`),
      );
    return { received: true };
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

  // POST /v1/payments/orders/:orderId/payment-link
  @Post("orders/:orderId/payment-link")
  @Roles(...TILL_ROLES)
  @ApiOperation({
    summary: "POS Payment Link — hosted Stripe checkout URL for an unpaid order",
  })
  async createOrderPaymentLink(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { url } = await this.payments.createOrderPaymentLink(
      user.tenantId,
      orderId,
    );
    // smsConfigured lets the POS modal show/hide the "Text link to customer" row.
    return { url, smsConfigured: this.payments.smsConfigured() };
  }

  // GET /v1/payments/pay/:code — PUBLIC resolver for the texted short link.
  // The web `/p/:code` route calls this and 302-redirects the customer to the
  // returned Stripe checkout URL. No auth: the code itself is the credential,
  // exactly like the hosted payment link.
  @Public()
  @Get("pay/:code")
  @ApiOperation({ summary: "Resolve a short payment-link code to a Stripe URL" })
  async resolvePaymentLink(@Param("code") code: string) {
    return this.payments.resolvePaymentLinkByCode(code);
  }

  // POST /v1/payments/orders/:orderId/payment-link/sms
  @Post("orders/:orderId/payment-link/sms")
  @Roles(...TILL_ROLES)
  @ApiOperation({
    summary: "Text the order's hosted payment link to the customer (billable SMS)",
  })
  sendOrderPaymentLinkSms(
    @Param("orderId") orderId: string,
    @Body() body: { phone?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.sendOrderPaymentLinkSms(
      user.tenantId,
      orderId,
      body?.phone ?? "",
      user.userId,
    );
  }

  // POST /v1/payments/orders/:orderId/receipt/email
  //
  // Apple's Tap to Pay App Review checklist (5.10) requires that a customer
  // can be sent a confidential digital receipt for an in-person sale —
  // whether it was approved OR declined — not just handed a printed one.
  // Staff key in the address at the counter (Order has no customerEmail for
  // walk-ins). Free to send, unlike the billable SMS route above.
  @Post("orders/:orderId/receipt/email")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Email the customer a receipt for this order" })
  emailOrderReceipt(
    @Param("orderId") orderId: string,
    @Body() body: { email?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const to = (body?.email ?? "").trim();
    // Deliberately strict-ish but not RFC-complete: catches the realistic
    // counter typo (missing @, trailing comma) without rejecting valid
    // addresses. Resend does the authoritative validation.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException("Enter a valid email address.");
    }
    return this.receiptEmail.sendOrderReceipt({
      tenantId: user.tenantId,
      orderId,
      to,
    });
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
      userId: user.userId,
      role: user.role,
    };
    return this.payments.getLedger(user.tenantId, opts);
  }

  // GET /v1/payments/payouts
  //
  // Kept for the summary card on this page, but the work is done by
  // PayoutsService so there is exactly ONE code path that decides which
  // locations' money a caller may see. The previous implementation here read
  // the whole tenant, which handed a single-shop owner every other shop's
  // takings.
  @Get("payouts")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Get Stripe payout history (scoped to the caller)" })
  async getPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    const { payouts } = await this.payouts.list(
      user.tenantId,
      user.userId,
      user.role,
      { limit: limit ? parseInt(limit, 10) : 20 },
    );
    return payouts;
  }

  // GET /v1/payments/reconcile?date=YYYY-MM-DD
  @Get("reconcile")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
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
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({
    summary:
      "List Connect status for every brand. Pass ?locationId= to scope to a single location's brands.",
  })
  listBrandConnectStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.payments.listBrandConnectStatus(user.tenantId, locationId);
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
