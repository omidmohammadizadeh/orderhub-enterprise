import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

// Lazy-imported only if STRIPE_SECRET_KEY is present
let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  // Stripe not installed — all calls will use mock paths
}

// String-literal enum mirrors for Phase F (until prisma generate runs)
const PaymentRecordStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
} as const;
type PaymentRecordStatus = (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

const RefundStatus = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

const LedgerEntryType = {
  PAYMENT: "PAYMENT",
  REFUND: "REFUND",
  PAYOUT: "PAYOUT",
  PLATFORM_FEE: "PLATFORM_FEE",
  PROCESSING_FEE: "PROCESSING_FEE",
  ADJUSTMENT: "ADJUSTMENT",
  TIP: "TIP",
} as const;
type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

const PayoutStatus = {
  PENDING: "PENDING",
  IN_TRANSIT: "IN_TRANSIT",
  PAID: "PAID",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

const PaymentStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  FAILED: "FAILED",
} as const;
type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export type PaymentMethodType =
  | "CARD"
  | "APPLE_PAY"
  | "GOOGLE_PAY"
  | "CASH"
  | "VOUCHER"
  | "BANK_TRANSFER"
  | "CRYPTO";

export interface CreatePaymentIntentDto {
  amount: number;
  currency: string;
  method: PaymentMethodType;
  tipAmount?: number;
  customerId?: string;
}

export interface CreateRefundDto {
  amount: number;
  reason?: string;
  note?: string;
}

export interface GetLedgerOpts {
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// Platform fee rate (1.5%)
const PLATFORM_FEE_RATE = new Decimal("0.015");
// Stripe processing fee rate (~1.4% + £0.20 flat — simplified here)
const PROCESSING_FEE_RATE = new Decimal("0.014");
const PROCESSING_FEE_FLAT = new Decimal("0.20");

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: any | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    if (key && Stripe) {
      this.stripe = new Stripe(key, { apiVersion: "2024-06-20" });
      this.logger.log("Stripe SDK initialised");
    } else {
      this.stripe = null;
      this.logger.warn(
        "STRIPE_SECRET_KEY not set — Stripe calls will use mock data",
      );
    }
  }

  // ── Payment Intent ─────────────────────────────────────────────────────────

  async createPaymentIntent(
    tenantId: string,
    orderId: string,
    dto: CreatePaymentIntentDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    const amount = new Decimal(dto.amount.toFixed(2));
    const tipAmount = new Decimal((dto.tipAmount ?? 0).toFixed(2));
    const total = amount.add(tipAmount);
    const platformFee = total.mul(PLATFORM_FEE_RATE).toDecimalPlaces(2);
    const processingFee = total
      .mul(PROCESSING_FEE_RATE)
      .add(PROCESSING_FEE_FLAT)
      .toDecimalPlaces(2);
    const netAmount = total.sub(platformFee).sub(processingFee).toDecimalPlaces(2);

    // Attempt Stripe PaymentIntent creation
    let stripePaymentIntentId: string | null = null;
    let stripeClientSecret: string | null = null;

    if (this.stripe) {
      try {
        const connectAccount = await this.prisma.stripeConnectAccount.findFirst({
          where: { tenantId },
        });

        const intentParams: any = {
          amount: Math.round(total.toNumber() * 100), // Stripe expects pence
          currency: (dto.currency ?? "gbp").toLowerCase(),
          metadata: { orderId, tenantId },
        };

        if (connectAccount?.stripeAccountId) {
          intentParams.transfer_data = {
            destination: connectAccount.stripeAccountId,
          };
          intentParams.application_fee_amount = Math.round(
            platformFee.toNumber() * 100,
          );
        }

        const intent = await this.stripe.paymentIntents.create(intentParams);
        stripePaymentIntentId = intent.id;
        stripeClientSecret = intent.client_secret;
      } catch (err: any) {
        this.logger.error(`Stripe PaymentIntent creation failed: ${err.message}`);
        // Fall through — store PENDING payment without Stripe ID
      }
    } else {
      stripePaymentIntentId = `mock_pi_${Date.now()}`;
      stripeClientSecret = `mock_secret_${Date.now()}`;
    }

    // Persist Payment record (PENDING)
    const payment = await (this.prisma as any).payment.create({
      data: {
        tenantId,
        orderId,
        stripePaymentIntentId,
        amount,
        currency: (dto.currency ?? "gbp").toLowerCase(),
        status: PaymentRecordStatus.PENDING,
        method: dto.method,
        tipAmount,
        platformFee,
        processingFee,
        netAmount,
        metadata: { stripeClientSecret },
      },
    });

    // Write initial PENDING LedgerEntry
    await (this.prisma as any).ledgerEntry.create({
      data: {
        tenantId,
        paymentId: payment.id,
        type: LedgerEntryType.PAYMENT,
        amount: total,
        currency: (dto.currency ?? "gbp").toLowerCase(),
        description: `Payment intent for order ${orderId}`,
        reference: stripePaymentIntentId ?? payment.id,
        metadata: { status: "PENDING" },
      },
    });

    this.logger.log(
      `Payment intent created: ${payment.id} for order ${orderId} (${total} ${dto.currency})`,
    );

    return {
      paymentId: payment.id,
      stripePaymentIntentId,
      clientSecret: stripeClientSecret,
      amount: total,
      currency: (dto.currency ?? "gbp").toLowerCase(),
    };
  }

  // ── Confirm Payment ────────────────────────────────────────────────────────

  async confirmPayment(tenantId: string, paymentIntentId: string) {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId, tenantId },
    });
    if (!payment) throw new NotFoundException("Payment not found");

    if (payment.status === PaymentRecordStatus.SUCCEEDED) {
      return payment; // idempotent
    }

    const total = new Decimal(payment.amount).add(new Decimal(payment.tipAmount));

    // Update payment status to SUCCEEDED
    const updated = await (this.prisma as any).payment.update({
      where: { id: payment.id },
      data: { status: PaymentRecordStatus.SUCCEEDED },
    });

    // Write double-entry LedgerEntries: PAYMENT + PLATFORM_FEE + PROCESSING_FEE
    await this.prisma.$transaction([
      (this.prisma as any).ledgerEntry.create({
        data: {
          tenantId,
          paymentId: payment.id,
          type: LedgerEntryType.PAYMENT,
          amount: total.toDecimalPlaces(2),
          currency: payment.currency,
          description: `Payment confirmed for order ${payment.orderId}`,
          reference: paymentIntentId,
          metadata: { confirmed: true },
        },
      }),
      (this.prisma as any).ledgerEntry.create({
        data: {
          tenantId,
          paymentId: payment.id,
          type: LedgerEntryType.PLATFORM_FEE,
          amount: new Decimal(payment.platformFee).toDecimalPlaces(2),
          currency: payment.currency,
          description: `Platform fee for payment ${payment.id}`,
          reference: paymentIntentId,
          metadata: {},
        },
      }),
      (this.prisma as any).ledgerEntry.create({
        data: {
          tenantId,
          paymentId: payment.id,
          type: LedgerEntryType.PROCESSING_FEE,
          amount: new Decimal(payment.processingFee).toDecimalPlaces(2),
          currency: payment.currency,
          description: `Processing fee for payment ${payment.id}`,
          reference: paymentIntentId,
          metadata: {},
        },
      }),
      // Update order payment status to PAID
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.PAID as any },
      }),
    ]);

    // Emit real-time update
    this.socket.emitToTenant(tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: "PAID",
    } as any);

    this.logger.log(`Payment confirmed: ${payment.id} (order ${payment.orderId})`);
    return updated;
  }

  // ── Refund ─────────────────────────────────────────────────────────────────

  async createRefund(
    tenantId: string,
    paymentId: string,
    dto: CreateRefundDto,
  ) {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { id: paymentId, tenantId },
      include: { refunds: true },
    });
    if (!payment) throw new NotFoundException("Payment not found");

    if (payment.status !== PaymentRecordStatus.SUCCEEDED) {
      throw new BadRequestException("Only succeeded payments can be refunded");
    }

    const refundAmount = new Decimal(dto.amount.toFixed(2));
    const totalAmount = new Decimal(payment.amount).add(new Decimal(payment.tipAmount));

    // Check total refunded so far
    const alreadyRefunded = (payment.refunds as any[])
      .filter((r: any) => r.status === RefundStatus.SUCCEEDED)
      .reduce((sum: Decimal, r: any) => sum.add(new Decimal(r.amount)), new Decimal("0"));

    const remainingRefundable = totalAmount.sub(alreadyRefunded);
    if (refundAmount.greaterThan(remainingRefundable)) {
      throw new BadRequestException(
        `Refund amount ${refundAmount} exceeds refundable amount ${remainingRefundable}`,
      );
    }

    const isPartial = refundAmount.lessThan(totalAmount);

    let stripeRefundId: string | null = null;

    if (this.stripe && payment.stripePaymentIntentId) {
      try {
        const stripeRefund = await this.stripe.refunds.create({
          payment_intent: payment.stripePaymentIntentId,
          amount: Math.round(refundAmount.toNumber() * 100),
          reason: dto.reason ?? "requested_by_customer",
        });
        stripeRefundId = stripeRefund.id;
      } catch (err: any) {
        this.logger.error(`Stripe refund failed: ${err.message}`);
        stripeRefundId = null;
      }
    } else {
      stripeRefundId = `mock_re_${Date.now()}`;
    }

    const isFullRefund = refundAmount.greaterThanOrEqualTo(remainingRefundable);

    const result = await this.prisma.$transaction(async (tx: any) => {
      const createdRefund = await tx.refund.create({
        data: {
          tenantId,
          paymentId,
          stripeRefundId,
          amount: refundAmount,
          reason: dto.reason ?? null,
          status: RefundStatus.SUCCEEDED,
          isPartial,
          note: dto.note ?? null,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          paymentId,
          refundId: createdRefund.id,
          type: LedgerEntryType.REFUND,
          amount: refundAmount,
          currency: payment.currency,
          description: `Refund for payment ${paymentId}${dto.reason ? `: ${dto.reason}` : ""}`,
          reference: stripeRefundId ?? createdRefund.id,
          metadata: { isPartial },
        },
      });

      // Update payment status
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: isFullRefund
            ? PaymentRecordStatus.REFUNDED
            : PaymentRecordStatus.SUCCEEDED,
        },
      });

      // Update order payment status
      await tx.order.update({
        where: { id: payment.orderId },
        data: {
          paymentStatus: isFullRefund
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });

      return createdRefund;
    });

    this.socket.emitToTenant(tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
    } as any);

    this.logger.log(
      `Refund created: ${result.id} — ${refundAmount} for payment ${paymentId}`,
    );
    return result;
  }

  // ── Phase AP-8 — Stripe Connect manual-capture flow ────────────────────────
  //
  // Used by the online-ordering storefront. Customer hits "Place order" with
  // payment method CARD → API calls createCheckoutSession → storefront
  // redirects to the Stripe-hosted Checkout page → customer enters card (or
  // Apple Pay / Google Pay / Link — Stripe auto-detects) → Stripe AUTHORIZES
  // the card (manual capture mode, money held but not taken).
  //
  // Then four order-lifecycle hooks trigger the rest:
  //
  //   1. Restaurant accepts          → captureForOrder()         → money taken
  //   2. Restaurant rejects pre-cap  → cancelAuthForOrder()      → hold released
  //   3. Restaurant cancels post-cap → refundForOrder()          → money returned
  //   4. Stripe webhook events       → reflect state into DB

  /**
   * Look up the operative Stripe Connect account for a location, preferring
   * a location-scoped account and falling back to a tenant-level one.
   *
   * Why two levels: the operator can either give every restaurant its own
   * onboarded Connect account (location-scoped, the multi-restaurant case)
   * OR run one account for the whole tenant (single-shop case). We honour
   * either configuration without forcing one model.
   */
  /**
   * Public so OrderingService.checkout can pre-flight the lookup
   * BEFORE creating an Order — otherwise a failed createCheckoutSession
   * leaves orphan orders showing up on the staff board.
   *
   * Three levels of lookup, first match wins:
   *
   *   1. StripeConnectAccount row scoped to this location (the proper
   *      multi-restaurant setup once they've completed Connect
   *      onboarding through the platform).
   *   2. StripeConnectAccount row scoped to the tenant (single-shop
   *      operators).
   *   3. The raw `acct_…` ID pasted by the operator into the Location
   *      settings field (`stripeConnectedAccountId`). This is the
   *      "I already have a Stripe account, just take the money there"
   *      escape hatch — no DB row, no chargesEnabled flag, we trust
   *      Stripe to validate.
   *
   * Returns null if all three miss.
   */
  async resolveConnectAccount(
    tenantId: string,
    locationId: string,
  ): Promise<{ id: string | null; stripeAccountId: string } | null> {
    const locationLevel = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, locationId, chargesEnabled: true },
    });
    if (locationLevel) {
      return { id: locationLevel.id, stripeAccountId: locationLevel.stripeAccountId };
    }
    const tenantLevel = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, locationId: null, chargesEnabled: true },
    });
    if (tenantLevel) {
      return { id: tenantLevel.id, stripeAccountId: tenantLevel.stripeAccountId };
    }
    // Escape hatch: operator pasted an acct_… ID directly on the
    // Location settings. We have no `StripeConnectAccount` row to
    // link the Payment to, so id stays null and we just stash the
    // raw account id for the transfer.
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { stripeConnectedAccountId: true },
    });
    const raw = location?.stripeConnectedAccountId?.trim();
    if (raw && raw.startsWith("acct_")) {
      return { id: null, stripeAccountId: raw };
    }
    return null;
  }

  /**
   * Compute application_fee_amount from the location's per-location fee
   * configuration. Falls back to the global PLATFORM_FEE_RATE if the
   * location has no fee config — keeps things working out of the box.
   */
  private computeApplicationFeePence(
    location: any,
    basketGbp: number,
  ): number {
    const mode = location?.applicationFeeMode as
      | "none"
      | "fixed_only"
      | "percentage_only"
      | "fixed_and_percentage"
      | null
      | undefined;
    if (!mode || mode === "none") {
      return Math.round(basketGbp * PLATFORM_FEE_RATE.toNumber() * 100);
    }
    const fixed = Number(location.applicationFeeFixedAmount ?? 0);
    const pct = Number(location.applicationFeePercentage ?? 0);
    const usesFixed = mode === "fixed_only" || mode === "fixed_and_percentage";
    const usesPct = mode === "percentage_only" || mode === "fixed_and_percentage";
    const fixedPart = usesFixed ? fixed : 0;
    const pctPart = usesPct ? basketGbp * (pct / 100) : 0;
    return Math.round((fixedPart + pctPart) * 100);
  }

  /**
   * Create a Stripe Checkout Session in manual-capture mode for the given
   * order. Returns the hosted-checkout URL the storefront should redirect
   * the customer to.
   *
   * The Payment row is created up-front in PENDING state so we have
   * something to reconcile when the webhook arrives. We attach the Stripe
   * Checkout Session ID + the future PaymentIntent ID via metadata so the
   * webhook can find it.
   */
  async createCheckoutSession(params: {
    tenantId: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
  }): Promise<{ url: string; sessionId: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        items: true,
        location: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.locationId) {
      throw new BadRequestException("Order has no location");
    }
    if (!this.stripe) {
      throw new BadRequestException(
        "Stripe is not configured on the server — set STRIPE_SECRET_KEY",
      );
    }

    const connect = await this.resolveConnectAccount(
      params.tenantId,
      order.locationId,
    );
    if (!connect) {
      throw new BadRequestException(
        "This location has no active Stripe Connect account — restaurant must complete Stripe onboarding before accepting card payments.",
      );
    }

    // Order doesn't have a currency column today — every existing Payment
    // defaults to GBP per the Phase F schema, and the storefront is UK-
    // only. Hardcode here, override later if/when multi-currency lands.
    const currency = "gbp";
    const totalGbp = Number(order.total);
    const applicationFeePence = this.computeApplicationFeePence(
      order.location,
      totalGbp,
    );

    // One line item for the cart subtotal + one each for delivery / tax /
    // tip / discount as needed. Stripe shows each line on the hosted
    // checkout page, so itemising helps the customer recognise their cart.
    const lineItems: any[] = order.items.map((it: any) => ({
      price_data: {
        currency,
        product_data: { name: it.name },
        unit_amount: Math.round(Number(it.unitPrice) * 100),
      },
      quantity: it.quantity,
    }));
    const addLine = (label: string, amountGbp: number) => {
      if (amountGbp > 0.005) {
        lineItems.push({
          price_data: {
            currency,
            product_data: { name: label },
            unit_amount: Math.round(amountGbp * 100),
          },
          quantity: 1,
        });
      }
    };
    addLine("Delivery", Number(order.deliveryFee ?? 0));
    addLine("Service / tax", Number(order.taxAmount ?? 0));

    // Build the base session params we'll try first (with Connect
    // transfer + application fee).
    const baseSessionParams: any = {
      mode: "payment",
      line_items: lineItems,
      customer_email: params.customerEmail || undefined,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        capture_method: "manual",
        application_fee_amount: applicationFeePence,
        transfer_data: { destination: connect.stripeAccountId },
        metadata: {
          orderId: order.id,
          tenantId: params.tenantId,
          locationId: order.locationId,
        },
      },
      metadata: {
        orderId: order.id,
        tenantId: params.tenantId,
        locationId: order.locationId,
      },
    };

    // Try Connect destination charge first; if Stripe rejects because the
    // Connect account doesn't have the `transfers` capability yet, retry as
    // a direct charge to the platform's own Stripe account. This unblocks
    // operators who pasted a raw acct_… ID before completing proper Connect
    // onboarding (transfers capability is the gate Stripe puts in front of
    // automated balance routing). The operator's money still ends up in
    // their platform Stripe balance — they just have to manually transfer
    // it out to the restaurant or enable transfers and re-test.
    let session;
    let usedDirectCharge = false;
    try {
      session = await this.stripe.checkout.sessions.create(baseSessionParams);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const capabilityMissing =
        msg.includes("capabilities") &&
        (msg.includes("transfers") || msg.includes("legacy_payments"));
      if (capabilityMissing) {
        this.logger.warn(
          `Connect destination charge rejected (capabilities missing on ${connect.stripeAccountId}). ` +
            `Retrying as direct charge to platform account. Operator should enable transfers on the Connect account.`,
        );
        // Direct-charge fallback: drop transfer_data + application_fee.
        // Money lands in the platform's Stripe balance, NOT the
        // restaurant's. Operator must reconcile manually until they
        // complete Connect onboarding.
        const fallbackParams = { ...baseSessionParams };
        fallbackParams.payment_intent_data = {
          capture_method: "manual",
          metadata: baseSessionParams.payment_intent_data.metadata,
        };
        try {
          session = await this.stripe.checkout.sessions.create(fallbackParams);
          usedDirectCharge = true;
        } catch (err2: any) {
          this.logger.error(
            `Stripe direct-charge fallback also failed: ${err2.message}`,
          );
          throw new BadRequestException(
            `Couldn't start Stripe checkout: ${err2.message}`,
          );
        }
      } else {
        this.logger.error(`Stripe Checkout Session create failed: ${msg}`);
        throw new BadRequestException(
          `Couldn't start Stripe checkout: ${msg}`,
        );
      }
    }

    if (usedDirectCharge) {
      // Mark the metadata so the webhook handler + operator dashboards
      // can tell the two flows apart at reconciliation time.
      try {
        await this.stripe.checkout.sessions.update(session.id, {
          metadata: { ...session.metadata, chargeMode: "direct_fallback" },
        });
      } catch {
        /* best-effort metadata stamp — not worth blocking checkout */
      }
    }

    // Persist Payment row in PENDING — webhook fills the rest.
    const totalDecimal = new Decimal(totalGbp.toFixed(2));
    const platformFeeDecimal = new Decimal(applicationFeePence).div(100);
    const processingFeeDecimal = totalDecimal
      .mul(PROCESSING_FEE_RATE)
      .add(PROCESSING_FEE_FLAT)
      .toDecimalPlaces(2);
    const netAmountDecimal = totalDecimal
      .sub(platformFeeDecimal)
      .sub(processingFeeDecimal)
      .toDecimalPlaces(2);

    await (this.prisma as any).payment.create({
      data: {
        tenantId: params.tenantId,
        orderId: order.id,
        // Null when using the raw-acct_id escape hatch (no
        // StripeConnectAccount row exists yet — link will fill in
        // later if/when the operator completes proper Connect
        // onboarding through the platform).
        stripeConnectAccountId: connect.id ?? null,
        stripePaymentIntentId: session.payment_intent ?? null,
        amount: totalDecimal,
        currency,
        status: PaymentRecordStatus.PENDING,
        method: "CARD",
        tipAmount: new Decimal(0),
        platformFee: platformFeeDecimal,
        processingFee: processingFeeDecimal,
        netAmount: netAmountDecimal,
        metadata: { stripeCheckoutSessionId: session.id },
      },
    });

    this.logger.log(
      `Stripe Checkout Session created for order ${order.id} -> ${session.id}`,
    );
    return { url: session.url, sessionId: session.id };
  }

  /**
   * Restaurant accepted the order — capture the held authorization. Safe
   * to call for non-card orders (cash etc.); returns early if there's
   * nothing to capture.
   */
  async captureForOrder(orderId: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment || !payment.stripePaymentIntentId) return;
    if (
      payment.status === PaymentRecordStatus.SUCCEEDED ||
      payment.status === PaymentRecordStatus.REFUNDED ||
      payment.status === PaymentRecordStatus.CANCELLED
    ) {
      return; // already terminal
    }
    if (!this.stripe) return;
    try {
      await this.stripe.paymentIntents.capture(payment.stripePaymentIntentId);
      this.logger.log(
        `Stripe capture invoked for order ${orderId} (PI ${payment.stripePaymentIntentId})`,
      );
      // The payment_intent.succeeded webhook will flip statuses + write
      // ledger entries. We don't update DB here to avoid drift.
    } catch (err: any) {
      this.logger.error(
        `Stripe capture failed for order ${orderId}: ${err.message}`,
      );
      throw new BadRequestException(`Capture failed: ${err.message}`);
    }
  }

  /**
   * Restaurant rejected the order before capture — release the hold.
   * Customer sees no charge on their statement.
   */
  async cancelAuthForOrder(orderId: string, reason?: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment || !payment.stripePaymentIntentId) return;
    if (
      payment.status === PaymentRecordStatus.CANCELLED ||
      payment.status === PaymentRecordStatus.REFUNDED ||
      payment.status === PaymentRecordStatus.FAILED
    ) {
      return; // already done
    }
    if (!this.stripe) return;
    try {
      await this.stripe.paymentIntents.cancel(payment.stripePaymentIntentId, {
        cancellation_reason: "requested_by_customer",
      });
      this.logger.log(
        `Stripe PI cancelled for order ${orderId} (reason: ${reason ?? "n/a"})`,
      );
      // payment_intent.canceled webhook will flip statuses.
    } catch (err: any) {
      this.logger.error(
        `Stripe cancel failed for order ${orderId}: ${err.message}`,
      );
      throw new BadRequestException(`Authorization cancel failed: ${err.message}`);
    }
  }

  /**
   * Order cancelled AFTER the restaurant accepted (and we captured).
   * Issues a full refund. For pre-capture cancels, use cancelAuthForOrder
   * instead — it's cheaper and the customer never sees a charge.
   */
  async refundForOrder(orderId: string, reason?: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment || !payment.stripePaymentIntentId) return;
    if (payment.status !== PaymentRecordStatus.SUCCEEDED) {
      // Not captured yet → use cancel-auth path instead.
      return this.cancelAuthForOrder(orderId, reason);
    }
    if (!this.stripe) return;
    try {
      const total = new Decimal(payment.amount).add(new Decimal(payment.tipAmount));
      await this.stripe.refunds.create({
        payment_intent: payment.stripePaymentIntentId,
        amount: Math.round(total.toNumber() * 100),
        reason: "requested_by_customer",
        metadata: { orderId, reason: reason ?? "" },
      });
      this.logger.log(
        `Stripe refund created for order ${orderId} (PI ${payment.stripePaymentIntentId})`,
      );
      // charge.refunded webhook will flip statuses + write ledger entries.
    } catch (err: any) {
      this.logger.error(`Stripe refund failed for order ${orderId}: ${err.message}`);
      throw new BadRequestException(`Refund failed: ${err.message}`);
    }
  }

  /**
   * Webhook handler — Stripe authorization succeeded. The Order joins the
   * staff board now (with paymentStatus AUTHORIZED) so the restaurant
   * can accept or reject it.
   */
  async markAuthorized(paymentIntentId: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (!payment) return;
    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { status: PaymentRecordStatus.PROCESSING },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: "AUTHORIZED" as any },
      }),
    ]);
    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: "AUTHORIZED",
    } as any);
  }

  /**
   * Webhook handler — Stripe authorization cancelled (we called cancel(),
   * or Stripe auto-released a stale hold). Mark Payment and Order
   * accordingly.
   */
  async markCancelled(paymentIntentId: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (!payment) return;
    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { status: PaymentRecordStatus.CANCELLED },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: "FAILED" as any },
      }),
    ]);
    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: "FAILED",
    } as any);
  }

  /**
   * Webhook handler — Stripe charge refunded. Cover the case where staff
   * cancelled an already-captured order; reflect REFUNDED on both
   * Payment and Order.
   */
  async markRefunded(chargeId: string, refundAmountPence: number): Promise<void> {
    // Look up by charge ID via the Payment.stripeChargeId column, OR by
    // resolving the charge -> PaymentIntent if our row only has the PI.
    let payment = await (this.prisma as any).payment.findFirst({
      where: { stripeChargeId: chargeId },
    });
    if (!payment && this.stripe) {
      try {
        const charge = await this.stripe.charges.retrieve(chargeId);
        if (charge?.payment_intent) {
          payment = await (this.prisma as any).payment.findFirst({
            where: { stripePaymentIntentId: charge.payment_intent },
          });
        }
      } catch {
        /* swallow — payment will just be null */
      }
    }
    if (!payment) return;

    const total = new Decimal(payment.amount).add(new Decimal(payment.tipAmount));
    const refundedGbp = new Decimal(refundAmountPence).div(100);
    const isFull = refundedGbp.greaterThanOrEqualTo(total.sub(new Decimal("0.01")));

    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: {
          status: isFull
            ? PaymentRecordStatus.REFUNDED
            : PaymentRecordStatus.SUCCEEDED,
        },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: {
          paymentStatus: (isFull ? "REFUNDED" : "PARTIALLY_REFUNDED") as any,
        },
      }),
    ]);
    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: isFull ? "REFUNDED" : "PARTIALLY_REFUNDED",
    } as any);
  }

  // ── Query Methods ──────────────────────────────────────────────────────────

  async getPaymentsByOrder(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    return (this.prisma as any).payment.findMany({
      where: { orderId, tenantId },
      include: {
        refunds: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getLedger(tenantId: string, opts: GetLedgerOpts = {}) {
    const { startDate, endDate, limit = 50, offset = 0 } = opts;

    const where: any = { tenantId };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [data, total] = await this.prisma.$transaction([
      (this.prisma as any).ledgerEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      (this.prisma as any).ledgerEntry.count({ where }),
    ]);

    return { data, total, limit, offset };
  }

  async getPayoutHistory(tenantId: string, limit = 20) {
    return (this.prisma as any).payout.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { connectAccount: { select: { stripeAccountId: true } } },
    });
  }

  async reconcile(tenantId: string, date: string) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const entries: any[] = await (this.prisma as any).ledgerEntry.findMany({
      where: {
        tenantId,
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: { type: true, amount: true, currency: true },
    });

    const summary: Record<string, Decimal> = {};

    for (const entry of entries) {
      const key = entry.type as string;
      summary[key] = (summary[key] ?? new Decimal("0")).add(new Decimal(entry.amount));
    }

    const grossRevenue = summary[LedgerEntryType.PAYMENT] ?? new Decimal("0");
    const totalRefunds = summary[LedgerEntryType.REFUND] ?? new Decimal("0");
    const platformFees = summary[LedgerEntryType.PLATFORM_FEE] ?? new Decimal("0");
    const processingFees =
      summary[LedgerEntryType.PROCESSING_FEE] ?? new Decimal("0");
    const netRevenue = grossRevenue
      .sub(totalRefunds)
      .sub(platformFees)
      .sub(processingFees)
      .toDecimalPlaces(2);

    return {
      date,
      tenantId,
      grossRevenue: grossRevenue.toDecimalPlaces(2),
      totalRefunds: totalRefunds.toDecimalPlaces(2),
      platformFees: platformFees.toDecimalPlaces(2),
      processingFees: processingFees.toDecimalPlaces(2),
      netRevenue,
      breakdown: Object.fromEntries(
        Object.entries(summary).map(([k, v]) => [k, v.toDecimalPlaces(2)]),
      ),
    };
  }

  async getConnectAccount(tenantId: string) {
    const account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId },
    });
    if (!account) throw new NotFoundException("Stripe Connect account not found");
    return account;
  }

  async createConnectOnboardingLink(tenantId: string) {
    let account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId },
    });

    if (!account) {
      let stripeAccountId = `mock_acct_${tenantId.slice(0, 8)}`;

      if (this.stripe) {
        try {
          const stripeAccount = await this.stripe.accounts.create({
            type: "express",
            metadata: { tenantId },
          });
          stripeAccountId = stripeAccount.id;
        } catch (err: any) {
          this.logger.error(`Stripe account creation failed: ${err.message}`);
        }
      }

      account = await (this.prisma as any).stripeConnectAccount.create({
        data: {
          tenantId,
          stripeAccountId,
          accountType: "EXPRESS",
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingComplete: false,
        },
      });
    }

    let onboardingUrl = `https://connect.stripe.com/setup/mock/${account.stripeAccountId}`;

    if (this.stripe) {
      try {
        const link = await this.stripe.accountLinks.create({
          account: account.stripeAccountId,
          refresh_url: `${this.config.get("APP_BASE_URL", "http://localhost:3000")}/billing/connect/refresh`,
          return_url: `${this.config.get("APP_BASE_URL", "http://localhost:3000")}/billing/connect/complete`,
          type: "account_onboarding",
        });
        onboardingUrl = link.url;
      } catch (err: any) {
        this.logger.error(`Stripe onboarding link creation failed: ${err.message}`);
      }
    }

    return { url: onboardingUrl, accountId: account.stripeAccountId };
  }

  // ── Webhook Handler ────────────────────────────────────────────────────────

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    const webhookSecret = this.config.get<string>("STRIPE_WEBHOOK_SECRET");

    let event: any;

    if (this.stripe && webhookSecret) {
      try {
        event = this.stripe.webhooks.constructEvent(
          rawBody,
          signature,
          webhookSecret,
        );
      } catch (err: any) {
        this.logger.error(`Stripe webhook signature verification failed: ${err.message}`);
        throw new BadRequestException("Invalid webhook signature");
      }
    } else {
      try {
        event = JSON.parse(rawBody.toString());
      } catch {
        throw new BadRequestException("Invalid webhook payload");
      }
    }

    this.logger.log(`Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const tenantId = pi.metadata?.tenantId;
        if (tenantId) {
          await this.confirmPayment(tenantId, pi.id).catch((err: any) =>
            this.logger.error(`confirmPayment via webhook failed: ${err.message}`),
          );
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const tenantId = pi.metadata?.tenantId;
        if (tenantId) {
          await (this.prisma as any).payment
            .updateMany({
              where: { stripePaymentIntentId: pi.id, tenantId },
              data: { status: PaymentRecordStatus.FAILED },
            })
            .catch((err: any) =>
              this.logger.error(`payment_failed update failed: ${err.message}`),
            );
        }
        break;
      }

      // Phase AP-8 — Stripe manual-capture lifecycle.
      case "payment_intent.amount_capturable_updated": {
        // Authorization succeeded; money is held but not yet captured.
        // Mark the order as AUTHORIZED so it joins the staff Orders board.
        const pi = event.data.object;
        await this.markAuthorized(pi.id).catch((err: any) =>
          this.logger.error(`markAuthorized failed: ${err.message}`),
        );
        break;
      }

      case "payment_intent.canceled": {
        // Either we called cancel() because staff rejected the order, or
        // Stripe auto-cancelled a stale uncaptured auth. Either way the
        // customer sees nothing on their statement.
        const pi = event.data.object;
        await this.markCancelled(pi.id).catch((err: any) =>
          this.logger.error(`markCancelled failed: ${err.message}`),
        );
        break;
      }

      case "charge.refunded": {
        // Staff cancelled an already-captured order, or a previous refund
        // was extended. Reflect into our Payment + Order state.
        const charge = event.data.object;
        const refunded = charge.amount_refunded ?? 0;
        await this.markRefunded(charge.id, refunded).catch((err: any) =>
          this.logger.error(`markRefunded failed: ${err.message}`),
        );
        break;
      }

      case "payout.paid":
      case "payout.failed": {
        const stripePayout = event.data.object;
        const status =
          event.type === "payout.paid" ? PayoutStatus.PAID : PayoutStatus.FAILED;

        const connectAccount = await (this.prisma as any).stripeConnectAccount.findUnique({
          where: { stripeAccountId: event.account ?? "" },
        });

        await (this.prisma as any).payout
          .upsert({
            where: { stripePayoutId: stripePayout.id },
            create: {
              tenantId: connectAccount?.tenantId ?? "unknown",
              connectAccountId: connectAccount?.id ?? null,
              stripePayoutId: stripePayout.id,
              amount: new Decimal((stripePayout.amount / 100).toFixed(2)),
              currency: stripePayout.currency,
              status,
              arrivalDate: stripePayout.arrival_date
                ? new Date(stripePayout.arrival_date * 1000)
                : null,
              description: stripePayout.description ?? null,
              metadata: { stripeObject: stripePayout },
            },
            update: { status },
          })
          .catch((err: any) =>
            this.logger.error(`Payout upsert failed: ${err.message}`),
          );
        break;
      }

      case "account.updated": {
        const acct = event.data.object;
        await (this.prisma as any).stripeConnectAccount
          .updateMany({
            where: { stripeAccountId: acct.id },
            data: {
              chargesEnabled: acct.charges_enabled ?? false,
              payoutsEnabled: acct.payouts_enabled ?? false,
              onboardingComplete:
                acct.details_submitted && acct.charges_enabled ? true : false,
            },
          })
          .catch((err: any) =>
            this.logger.error(`account.updated sync failed: ${err.message}`),
          );
        break;
      }

      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }

    return { received: true };
  }
}
