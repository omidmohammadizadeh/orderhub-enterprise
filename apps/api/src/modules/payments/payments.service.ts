import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomBytes } from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { SmsService } from "../sms/sms.service";
import { WalletService } from "../wallet/wallet.service";

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
  // When set (and the role isn't tenant-wide) the ledger is scoped to the
  // caller's accessible locations via payment → order → locationId.
  userId?: string;
  role?: string;
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
    private readonly events: EventEmitter2,
    private readonly sms: SmsService,
    private readonly wallet: WalletService,
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

  /**
   * Register a domain with Stripe so Apple Pay can be offered on it.
   *
   * Apple requires every domain that shows an Apple Pay button to be
   * registered and verified first — including each brand's own custom
   * domain, not just ours. Miss it and the button silently doesn't render:
   * no error, no console warning, the customer just sees one fewer way to
   * pay and nobody finds out until someone asks why Apple Pay "doesn't work
   * on that shop".
   *
   * `stripeAccount` is not optional decoration. We take DIRECT charges, so
   * the PaymentIntent lives on the restaurant's connected account and Stripe
   * looks for the registration THERE. A domain registered only on the
   * platform leaves Apple Pay dark on every shop — which is exactly what
   * happened: card rendered, Apple Pay never did. Destination-charge and
   * platform flows still register with no account.
   *
   * Idempotent by nature — re-registering an existing domain is a no-op on
   * Stripe's side — so it is safe to call on every domain connect and
   * re-verify.
   *
   * Never throws. A domain that can't be registered should leave the shop
   * taking cards as normal, not fail whatever flow the operator is in the
   * middle of.
   */
  async registerApplePayDomain(
    domain: string,
    stripeAccount?: string | null,
  ): Promise<boolean> {
    if (!this.stripe || !domain) return false;
    const scope = stripeAccount ? ` on ${stripeAccount}` : "";
    const opts = stripeAccount ? { stripeAccount } : undefined;
    try {
      // paymentMethodDomains, NOT the legacy applePayDomains: the legacy API
      // only governs the old Payment Request Button. Wallets in the Payment
      // Element and Express Checkout Element are gated on this one.
      const pmd = await (this.stripe as any).paymentMethodDomains.create(
        { domain_name: domain },
        opts,
      );
      // Registration succeeding is not the same as Apple Pay working — the
      // domain still has to pass Stripe's verification. Surface the reason
      // now rather than leaving someone to wonder why the button is missing.
      const apple = pmd?.apple_pay;
      if (apple?.status === "active") {
        this.logger.log(`Apple Pay active for ${domain}${scope}`);
      } else {
        this.logger.warn(
          `Apple Pay INACTIVE for ${domain}${scope}: ${
            apple?.status_details?.error_message ?? "no reason given"
          }`,
        );
      }
      return true;
    } catch (err: any) {
      // Already registered is a success, not a failure.
      const msg = String(err?.message ?? err);
      if (/already/i.test(msg)) {
        this.logger.log(`Apple Pay domain already registered: ${domain}${scope}`);
        return true;
      }
      this.logger.warn(
        `Apple Pay registration failed for ${domain}${scope}: ${msg}`,
      );
      return false;
    }
  }

  /**
   * Domains we've already registered for a given connected account, so the
   * lazy registration below costs one Stripe call per pair per process
   * rather than one per order. Created on demand rather than as a field
   * initialiser so this can never be the undefined that takes a payment
   * down with it.
   */
  private registeredPmDomains?: Set<string>;

  /**
   * Make sure the domains this storefront is served on are registered on the
   * connected account taking the charge, so the Apple Pay button renders.
   *
   * Domains come from what WE know we serve — the platform origin and the
   * brand's own custom domain — never from a request header. Registering an
   * attacker-supplied Origin would let a phishing page show Apple Pay against
   * a real restaurant's Stripe account.
   *
   * Fire-and-forget, and swallows everything: a failure here costs the wallet
   * button, not the order. Nothing about registering a domain is worth
   * refusing to take someone's money over.
   */
  private ensureWalletDomains(
    stripeAccount: string,
    customDomain?: string | null,
  ): void {
    try {
      const seen = (this.registeredPmDomains ??= new Set<string>());
      let platformHost: string | null = null;
      try {
        platformHost = new URL(
          process.env.WEB_URL ?? "https://www.orderhubsolutions.com",
        ).hostname;
      } catch {
        platformHost = null;
      }
      // Stripe registers an EXACT host, not a site: "example.com" does not
      // cover "www.example.com". A shop whose custom domain is stored apex
      // but served on www would get card-only with nothing to explain it, so
      // register both spellings of each.
      const hosts = new Set<string>();
      for (const domain of [platformHost, customDomain?.trim() || null]) {
        const host = domain?.trim().toLowerCase().replace(/^https?:\/\//, "");
        if (!host) continue;
        hosts.add(host);
        hosts.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
      }
      for (const host of hosts) {
        const key = `${stripeAccount}:${host}`;
        if (seen.has(key)) continue;
        seen.add(key);
        void this.registerApplePayDomain(host, stripeAccount);
      }
    } catch (err: any) {
      this.logger.warn(
        `Wallet domain registration skipped: ${err?.message ?? err}`,
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

    // Orders we held out of the New column + print until the money landed.
    // Payment just landed → light up the staff board (moves it from "Waiting
    // for payment" to New) and fire payment.authorized so an auto-accept
    // location captures + prints the ticket, exactly like a fresh order.
    //
    // CARD belongs here as well as the payment-link methods. The old comment
    // reasoned that online card orders "reach confirmPayment already
    // accepted" — true only while they were authorise-then-capture, where
    // markAuthorized did the broadcast and staff had already accepted by the
    // time capture happened. Embedded storefront payments capture outright,
    // so confirmPayment is the FIRST and only webhook they see: without this
    // the customer is charged, the order sits PAID and PENDING, and nobody in
    // the shop ever finds out. The status === "PENDING" guard is what stops a
    // double broadcast on the authorise-first path, not the method list.
    const paidOrder = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      include: { items: { select: { quantity: true } } },
    });
    const paidMethod = (paidOrder as any)?.paymentMethod;
    const weCollectedIt =
      paidMethod === "PAYMENT_LINK" ||
      paidMethod === "QR_CODE" ||
      // Scoped to the sources where WE take the payment. A marketplace
      // order arrives already settled and must not be re-announced.
      (paidMethod === "CARD" &&
        ["DIRECT", "ONLINE", "WHATSAPP"].includes(
          String(paidOrder?.orderSource),
        ));
    if (
      paidOrder &&
      paidOrder.locationId &&
      weCollectedIt &&
      paidOrder.status === "PENDING"
    ) {
      this.socket.emitNewOrder(paidOrder.locationId, {
        orderId: paidOrder.id,
        tenantId: paidOrder.tenantId,
        locationId: paidOrder.locationId,
        platform: paidOrder.platform,
        orderSource: paidOrder.orderSource,
        fulfillmentType: paidOrder.fulfillmentType,
        displayId: paidOrder.displayId,
        status: paidOrder.status,
        total: Number(paidOrder.total),
        itemCount: paidOrder.items.reduce((s, i) => s + (i.quantity ?? 0), 0),
        customerName: (paidOrder as any).customerName,
        scheduledFor: paidOrder.scheduledFor?.toISOString() ?? null,
        createdAt: paidOrder.createdAt.toISOString(),
      } as any);
      // Auto-accept + print if the location has the toggle on (same event the
      // online-card authorize path uses).
      this.events.emit("payment.authorized", {
        orderId: paidOrder.id,
        tenantId,
        locationId: paidOrder.locationId,
      });
    }

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
    brandId?: string | null,
  ): Promise<{ id: string | null; stripeAccountId: string } | null> {
    // Phase AW — brand-level raw-account escape hatch wins over the
    // location-level one. Each virtual brand at a shared kitchen can
    // route payouts to its own Stripe account by pasting an acct_… on
    // the Brand settings drawer. We only short-circuit when the brand
    // explicitly opts in (non-empty acct_…); a blank brand field
    // falls through to the existing per-location resolution.
    if (brandId) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: brandId },
        select: { stripeConnectedAccountId: true } as any,
      }) as any;
      const brandRaw = brand?.stripeConnectedAccountId?.trim();
      if (brandRaw && brandRaw.startsWith("acct_")) {
        return { id: null, stripeAccountId: brandRaw };
      }
    }

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
   * Phase AP-8 — application fee + customer service charge.
   *
   * Operator-specified rules for the four fee modes:
   *
   *   * fixed_only          — fixed amount ADDS to the customer bill.
   *                           Application fee = fixed.
   *                           Example: 50p fixed on £20 basket
   *                              → customer pays £20.50, platform keeps 50p,
   *                                restaurant gets £20.
   *
   *   * percentage_only     — percent does NOT change the customer bill.
   *                           Application fee = pct × basket.
   *                           Example: 5% on £20 basket
   *                              → customer pays £20, platform keeps £1,
   *                                restaurant gets £19.
   *
   *   * fixed_and_percentage — fixed ADDS to customer, percent does not.
   *                           Application fee = fixed + (pct × basket).
   *                           Example: 50p + 5% on £10 basket
   *                              → customer pays £10.50, platform keeps £1
   *                                (50p fixed + 50p which is 5% of £10),
   *                                restaurant gets £9.50.
   *
   *   * none                — no platform fee, no customer surcharge.
   *                           Direct charge to restaurant, zero application_fee.
   *
   * Returns both the customer-side surcharge (line-item value, in pence)
   * AND the application_fee_amount (Stripe takes from the captured charge,
   * in pence). The caller adds the surcharge as a Stripe line item so the
   * customer sees "Service charge" on the Stripe Checkout page.
   */
  private computeFeeBreakdownPence(
    location: any,
    basketGbp: number,
  ): { applicationFeePence: number; customerSurchargePence: number } {
    const mode = location?.applicationFeeMode as
      | "none"
      | "fixed_only"
      | "percentage_only"
      | "fixed_and_percentage"
      | null
      | undefined;
    if (!mode || mode === "none") {
      return { applicationFeePence: 0, customerSurchargePence: 0 };
    }
    const fixed = Number(location.applicationFeeFixedAmount ?? 0);
    const pct = Number(location.applicationFeePercentage ?? 0);
    const usesFixed = mode === "fixed_only" || mode === "fixed_and_percentage";
    const usesPct = mode === "percentage_only" || mode === "fixed_and_percentage";
    const fixedPart = usesFixed ? fixed : 0;
    const pctPart = usesPct ? basketGbp * (pct / 100) : 0;
    // application_fee_amount = what platform keeps (fixed + percent on basket)
    const applicationFeePence = Math.round((fixedPart + pctPart) * 100);
    // The fixed portion is added on top of the customer's bill as a
    // visible "Service charge" line. Percent is silent (taken from
    // the restaurant's share of the captured charge).
    const customerSurchargePence = usesFixed ? Math.round(fixed * 100) : 0;
    return { applicationFeePence, customerSurchargePence };
  }

  /**
   * Customer-facing fixed service charge (GBP) for a location — the same
   * "Service charge" line createCheckoutSession adds to the Stripe page.
   * Lets a channel (e.g. WhatsApp) show it in its own checkout summary so
   * the total it quotes matches what Stripe charges. Brand fee config wins
   * over the location's, mirroring createCheckoutSession's feeSource rule.
   */
  async customerServiceChargeGbp(locationId: string, basketGbp: number): Promise<number> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: {
        applicationFeeMode: true,
        applicationFeeFixedAmount: true,
        applicationFeePercentage: true,
        brand: {
          select: {
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          },
        },
      },
    });
    if (!location) return 0;
    const brand = (location as any).brand;
    const feeSource =
      brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
        ? brand
        : location;
    const { customerSurchargePence } = this.computeFeeBreakdownPence(feeSource, basketGbp);
    return Math.round(customerSurchargePence) / 100;
  }

  /**
   * Application-fee amount (pence) the platform keeps on a basket for a
   * location — brand fee config wins over the location's, same rule as
   * createCheckoutSession. Public so the Terminal (card-present) flow can
   * apply the identical Connect application fee as online orders.
   */
  async applicationFeePenceForBasket(
    locationId: string,
    basketGbp: number,
  ): Promise<number> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: {
        applicationFeeMode: true,
        applicationFeeFixedAmount: true,
        applicationFeePercentage: true,
        brand: {
          select: {
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          },
        },
      },
    });
    if (!location) return 0;
    const brand = (location as any).brand;
    const feeSource =
      brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
        ? brand
        : location;
    const { applicationFeePence } = this.computeFeeBreakdownPence(
      feeSource,
      basketGbp,
    );
    return Math.max(0, Math.round(applicationFeePence));
  }

  /**
   * Settle a card-present (Terminal) PaymentIntent — mark the linked Payment
   * SUCCEEDED and the Order PAID, then broadcast. Idempotent: re-settling an
   * already-paid order is a no-op. Called from the poll endpoint AND the
   * payment_intent.succeeded webhook (which branches here when the PI carries
   * metadata.source === "terminal"). Terminal charges capture immediately, so
   * this goes straight to PAID (unlike the online hold→AUTHORIZED flow).
   */
  async settleTerminalPi(pi: any): Promise<void> {
    const payment = await this.findPaymentForPi(pi);
    if (!payment) return;
    if (payment.status === PaymentRecordStatus.SUCCEEDED) return; // idempotent

    // ── Split bill ────────────────────────────────────────────────────
    // A part-payment settles ITSELF, not the bill. Marking the order PAID
    // here would clear a £48 table off the back of a £20 card tap, so the
    // order only flips once the banked parts actually cover the total.
    if ((payment.metadata as any)?.split) {
      await this.settleSplitPart(payment, pi);
      return;
    }

    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { status: PaymentRecordStatus.SUCCEEDED },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: "PAID" as any },
      }),
    ]);

    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: "PAID",
    } as any);

    // Card-terminal (S700 / WisePad 3) orders are held out of New + print until
    // the charge lands — same as POS "Payment link". Now that it's PAID, light
    // up the staff board (moves it from "Waiting for payment" to New) and fire
    // payment.authorized so an auto-accept location captures + prints the
    // ticket. Gated to still-PENDING orders so this never double-fires.
    const paidOrder = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      include: { items: { select: { quantity: true } } },
    });
    if (paidOrder && paidOrder.locationId && paidOrder.status === "PENDING") {
      this.socket.emitNewOrder(paidOrder.locationId, {
        orderId: paidOrder.id,
        tenantId: paidOrder.tenantId,
        locationId: paidOrder.locationId,
        platform: paidOrder.platform,
        orderSource: paidOrder.orderSource,
        fulfillmentType: paidOrder.fulfillmentType,
        displayId: paidOrder.displayId,
        status: paidOrder.status,
        total: Number(paidOrder.total),
        itemCount: paidOrder.items.reduce((s, i) => s + (i.quantity ?? 0), 0),
        customerName: (paidOrder as any).customerName,
        scheduledFor: paidOrder.scheduledFor?.toISOString() ?? null,
        createdAt: paidOrder.createdAt.toISOString(),
      } as any);
      this.events.emit("payment.authorized", {
        orderId: paidOrder.id,
        tenantId: payment.tenantId,
        locationId: paidOrder.locationId,
      });
    }

    // A dine-in tab paid in full on the reader must close itself, exactly
    // like the cash and split routes. Without this the order stayed PAID
    // but ACCEPTED and the table stayed occupied — the POS was trying to
    // finish the job with a status PATCH the forward-only ladder rejects
    // ("Invalid status transition: ACCEPTED → COMPLETED"), so it never
    // completed. OrdersService owns the ladder, so it does the closing.
    if (paidOrder?.tableId) {
      this.events.emit("order.settled_in_full", {
        orderId: payment.orderId,
        tenantId: payment.tenantId,
        locationId: paidOrder.locationId,
      });
    }

    this.logger.log(
      `Terminal payment settled: order ${payment.orderId} → PAID (pi ${pi?.id})`,
    );
  }

  /**
   * Bank one part of a split bill taken on a card reader.
   *
   * Marks just this Payment SUCCEEDED, then asks whether the parts now
   * cover the order. Only the part that closes the gap flips the order
   * to PAID — and, for a dine-in tab, fires `order.settled_in_full` so
   * OrdersService can run the SAME complete-and-free-the-table routine
   * the cash split path already uses (it owns the forward-only status
   * ladder; duplicating that logic here is how the two paths drift).
   */
  private async settleSplitPart(payment: any, pi: any): Promise<void> {
    await (this.prisma as any).payment.update({
      where: { id: payment.id },
      data: { status: PaymentRecordStatus.SUCCEEDED },
    });

    const order = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      select: {
        id: true,
        total: true,
        tableId: true,
        locationId: true,
        paymentStatus: true,
      },
    });
    if (!order) return;

    const rows = await (this.prisma as any).payment.findMany({
      where: { orderId: order.id, status: PaymentRecordStatus.SUCCEEDED },
      select: { amount: true },
    });
    const paid =
      Math.round(
        rows.reduce((s: number, p: any) => s + Number(p.amount), 0) * 100,
      ) / 100;
    const total = Number(order.total);
    const covered = paid >= total - 0.01;

    if (covered && order.paymentStatus !== "PAID") {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: "PAID" as any },
      });
      if (order.tableId) {
        this.events.emit("order.settled_in_full", {
          orderId: order.id,
          tenantId: payment.tenantId,
          locationId: order.locationId,
        });
      }
    }

    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: order.id,
      paymentStatus: covered ? "PAID" : "PARTIAL",
    } as any);

    this.logger.log(
      `Split card part settled: order ${order.id} £${Number(payment.amount).toFixed(2)} ` +
        `— paid £${paid.toFixed(2)}/${total.toFixed(2)}` +
        `${covered ? " (SETTLED)" : ""} (pi ${pi?.id})`,
    );
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
  /**
   * A PaymentIntent for a storefront order, for paying WITHOUT leaving the
   * site — the Payment Element and the Apple/Google Pay express buttons.
   *
   * Deliberately additive: createCheckoutSession below is untouched and stays
   * the live path until the storefront is switched over. Nothing calls this
   * yet, so it can't affect a real order.
   *
   * The money is resolved exactly as the hosted session does — same
   * brand-first Connect cascade, same fee breakdown — because two different
   * answers to "which account and how much fee" is precisely how a storefront
   * and a payout start disagreeing.
   *
   * Capture is AUTOMATIC: the customer's money is taken the moment they pay,
   * and the order flips straight to PAID. A wallet payment that showed as
   * "authorised" for twenty minutes while the shop decided reads as broken to
   * an Apple Pay customer. The trade is that rejecting an order now needs a
   * real refund rather than just letting a hold lapse.
   *
   * Like the hosted session, this is a DIRECT charge on the connected account
   * ({ stripeAccount }), not a destination charge. That is deliberate — see
   * the long note in createCheckoutSession. It means the browser must create
   * Stripe.js with the same `stripeAccount`, so we return it alongside the
   * secret; a clientSecret on its own can't be confirmed from the platform.
   */
  async createStorefrontPaymentIntent(params: {
    tenantId: string;
    orderId: string;
  }): Promise<{
    clientSecret: string;
    amountPence: number;
    stripeAccountId: string;
  }> {
    if (!this.stripe) {
      throw new BadRequestException("Card payments aren't configured.");
    }
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        location: true,
        brand: {
          select: {
            id: true,
            stripeConnectedAccountId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
            // Needed to register the brand's own domain for Apple Pay on
            // whichever connected account ends up taking the charge.
            customDomain: true,
          } as any,
        } as any,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.locationId) throw new BadRequestException("Order has no location");

    const connect = await this.resolveConnectAccount(
      params.tenantId,
      order.locationId,
      (order as any).brandId ?? null,
    );
    if (!connect) {
      throw new BadRequestException(
        "This brand has no active Stripe Connect account — operator must finish Stripe onboarding before accepting card payments.",
      );
    }

    // Apple Pay is gated on the domain being registered against the account
    // the charge runs on. Kicked off before the intent so the very first
    // order on a new account starts the clock; it won't help THAT order, but
    // the button appears from the next one rather than never.
    this.ensureWalletDomains(
      connect.stripeAccountId,
      (order as any).brand?.customDomain,
    );

    const totalGbp = Number(order.total);
    // Brand fee wins when set; falls back to the location. Same rule as the
    // hosted session — see createCheckoutSession.
    const brand = (order as any).brand as any;
    const feeSource =
      brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
        ? brand
        : order.location;
    const { applicationFeePence, customerSurchargePence } =
      this.computeFeeBreakdownPence(feeSource, totalGbp);

    // The fixed portion is a visible surcharge the customer pays on top, so
    // it has to be in the amount charged as well as in the platform's cut.
    const amountPence = Math.round(totalGbp * 100) + customerSurchargePence;

    let intent;
    try {
      intent = await this.stripe.paymentIntents.create(
        {
          amount: amountPence,
          currency: "gbp",
          capture_method: "automatic",
          // Card only — which still means Apple Pay and Google Pay, because
          // Stripe presents wallet tokens as card payments. The hosted
          // session pins the same list.
          //
          // automatic_payment_methods would be the obvious choice and is
          // wrong here: it offers everything the account has enabled, which
          // put Klarna in front of someone buying a £12 gyros. Buy-now-pay-
          // later on a takeaway is not a payment option, it's a support
          // ticket — and it pushed the wallet buttons down the list too.
          payment_method_types: ["card"],
          ...(applicationFeePence > 0 && {
            application_fee_amount: applicationFeePence,
          }),
          metadata: {
            orderId: order.id,
            tenantId: params.tenantId,
            locationId: order.locationId,
            ...(brand?.id ? { brandId: brand.id } : {}),
          },
        },
        // The single line that makes this a direct charge on the restaurant's
        // account rather than a platform charge — same as the hosted session.
        { stripeAccount: connect.stripeAccountId },
      );
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      this.logger.error(
        `Storefront PaymentIntent create failed on ${connect.stripeAccountId}: ${msg}`,
      );
      throw new BadRequestException(`Couldn't start card payment: ${msg}`);
    }

    if (!intent.client_secret) {
      throw new BadRequestException("Stripe didn't return a client secret.");
    }

    // The webhook finds the order through a Payment row — markPaid bails out
    // when there isn't one, which would leave a paid order sitting off the
    // staff board forever. Written in PENDING here, same as the hosted
    // session does, so the row exists before the customer can possibly pay.
    const totalDecimal = new Decimal(totalGbp.toFixed(2));
    const platformFeeDecimal = new Decimal(applicationFeePence).div(100);
    const processingFeeDecimal = totalDecimal
      .mul(PROCESSING_FEE_RATE)
      .add(PROCESSING_FEE_FLAT)
      .toDecimalPlaces(2);
    await (this.prisma as any).payment.create({
      data: {
        tenantId: params.tenantId,
        orderId: order.id,
        stripeConnectAccountId: connect.id ?? null,
        stripePaymentIntentId: intent.id,
        amount: totalDecimal,
        currency: "gbp",
        status: PaymentRecordStatus.PENDING,
        method: "CARD",
        tipAmount: new Decimal(0),
        platformFee: platformFeeDecimal,
        processingFee: processingFeeDecimal,
        netAmount: totalDecimal
          .sub(platformFeeDecimal)
          .sub(processingFeeDecimal)
          .toDecimalPlaces(2),
      },
    });

    this.logger.log(
      `PaymentIntent ${intent.id} for order ${order.id}: ${amountPence}p ` +
        `fee=${applicationFeePence}p acct=${connect.stripeAccountId}`,
    );
    return {
      clientSecret: intent.client_secret,
      amountPence,
      stripeAccountId: connect.stripeAccountId,
    };
  }

  async createCheckoutSession(params: {
    tenantId: string;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    // "manual" (default) authorises and waits for staff Accept before
    // capture — the storefront/online flow. "automatic" captures as soon
    // as the customer pays, flipping the order straight to PAID — used by
    // the POS "Payment Link" flow where there's no separate Accept step.
    captureMethod?: "manual" | "automatic";
  }): Promise<{ url: string; sessionId: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        items: true,
        location: true,
        // Phase AW — pull the brand's fee + Stripe account too so we can
        // prefer them over the location-level config below. Brand wins
        // when set (each virtual brand has its own payout account in
        // the spec); blank brand fields fall back to location.
        brand: {
          select: {
            id: true,
            stripeConnectedAccountId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          } as any,
        } as any,
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

    // Order doesn't have a currency column today — every existing Payment
    // defaults to GBP per the Phase F schema, and the storefront is UK-
    // only. Hardcode here, override later if/when multi-currency lands.
    const currency = "gbp";
    const totalGbp = Number(order.total);

    // ── POS "Payment link" Stripe override ─────────────────────────────────
    // A POS payment link (captureMethod "automatic") uses THIS location's
    // dedicated POS Stripe account + fee when configured, bypassing the
    // brand-first resolveConnectAccount cascade — so a shop's card links always
    // land on its own Stripe account (fixes links defaulting to a brand account
    // that can't take live charges).
    const loc = order.location as any;
    const posAcct = (loc?.posStripeAccountId ?? "").trim();
    const usePosOverride =
      params.captureMethod === "automatic" && posAcct.startsWith("acct_");

    let connect: { id: string | null; stripeAccountId: string } | null;
    let applicationFeePence: number;
    let customerSurchargePence = 0;

    if (usePosOverride) {
      connect = { id: null, stripeAccountId: posAcct };
      const pct = Number(loc?.posApplicationFeePercent ?? 0);
      const fixedPence = Math.max(
        0,
        Math.round(Number(loc?.posApplicationFeeFixedMinor ?? 0)),
      );
      // Match the online-ordering fee model:
      //   • Percentage → the platform's cut, taken from the RESTAURANT's
      //     payout (part of application_fee_amount). The customer is NOT
      //     charged for it — they pay only their normal basket total.
      //     `totalGbp` is in pounds and `pct` is a whole-percent value, so
      //     pounds×percent already yields pence of that percentage
      //     (÷100 for percent and ×100 for pounds→pence cancel out).
      //     The previous code divided by 100 again, so a 5% fee on a £1.20
      //     order rounded to 0 pence — which is why no fee was applied.
      //   • Fixed → added ON TOP of the customer's bill as a "Service
      //     charge" line (an add-on), and kept by the platform (included in
      //     application_fee_amount) so the restaurant doesn't absorb it.
      const pctPence = Math.max(0, Math.round(totalGbp * pct));
      customerSurchargePence = fixedPence;
      applicationFeePence = pctPence + fixedPence;
    } else {
      connect = await this.resolveConnectAccount(
        params.tenantId,
        order.locationId,
        (order as any).brandId ?? null,
      );
      if (!connect) {
        throw new BadRequestException(
          "This brand has no active Stripe Connect account — operator must finish Stripe onboarding before accepting card payments.",
        );
      }
      // Phase AW — brand-level fee config wins when its mode isn't
      // "none". Falls back to the location's config (the legacy single-
      // brand-per-location path) otherwise so existing payouts don't
      // change behaviour for tenants that haven't filled brand fees in.
      const brand = (order as any).brand as any;
      const feeSource =
        brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
          ? brand
          : order.location;
      const breakdown = this.computeFeeBreakdownPence(feeSource, totalGbp);
      applicationFeePence = breakdown.applicationFeePence;
      customerSurchargePence = breakdown.customerSurchargePence;
    }

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
    // The customer's gratuity. It belongs to the RESTAURANT, so it goes in
    // as an ordinary line on the destination charge and lands in the brand's
    // Connect account with the rest of the basket — no separate transfer and
    // nothing for the platform to take a cut of. Without this line the tip
    // would sit on the Order and never actually be charged, which is the
    // worst of both: the shop sees a tip it was never paid.
    addLine("Tip", Number((order as any).tipAmount ?? 0));
    // Phase AP-8 — visible fixed-fee surcharge on the customer side.
    // The customer pays this on top of the basket; the platform keeps
    // it as part of application_fee_amount. Only added when the
    // location's applicationFeeMode includes the fixed portion.
    if (customerSurchargePence > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: "Service charge" },
          unit_amount: customerSurchargePence,
        },
        quantity: 1,
      });
    }

    // DIRECT CHARGE on the connected account.
    //
    // Two Stripe Connect models route money differently:
    //
    //   * Destination charge — PaymentIntent created on the PLATFORM
    //     with transfer_data.destination = acct_…; after capture Stripe
    //     auto-transfers funds to the connected account. Requires the
    //     connected account to have the `transfers` capability enabled.
    //     The Charge object appears under the PLATFORM in Stripe
    //     dashboards.
    //
    //   * Direct charge — PaymentIntent created on the CONNECTED
    //     account by passing { stripeAccount: 'acct_…' } as a request
    //     option. application_fee_amount automatically transferred to
    //     the platform. Requires only the `card_payments` capability,
    //     which every Connect account has by default once they finish
    //     basic onboarding. The Charge appears under the CONNECTED
    //     account in Stripe dashboards — exactly what operators expect
    //     when they look at a single restaurant's revenue.
    //
    // Direct charges match the operator's mental model ("money goes to
    // the restaurant's account, my cut comes out of it") and avoid the
    // brittle transfers-capability dependency we hit on first deploy.
    const sessionParams: any = {
      mode: "payment",
      // Constrain to card only. Stripe's automatic_payment_methods would
      // surface Klarna / BNPL on a GBP session, but those methods don't
      // support capture_method=manual — picking one causes Checkout to
      // hang on "Processing…" and never confirm the PaymentIntent. Card
      // still covers Apple Pay / Google Pay (Stripe treats wallet
      // tokens as card payments), and both support manual capture.
      payment_method_types: ["card"],
      line_items: lineItems,
      customer_email: params.customerEmail || undefined,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      payment_intent_data: {
        capture_method: params.captureMethod ?? "manual",
        application_fee_amount: applicationFeePence,
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

    let session;
    try {
      // The { stripeAccount } request option is the single line that
      // makes this a direct charge instead of a platform charge.
      // Stripe-Node attaches it as the `Stripe-Account` HTTP header.
      session = await this.stripe.checkout.sessions.create(sessionParams, {
        stripeAccount: connect.stripeAccountId,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      this.logger.error(
        `Stripe direct-charge Checkout Session create failed on ${connect.stripeAccountId}: ${msg}`,
      );
      throw new BadRequestException(
        `Couldn't start Stripe checkout: ${msg}`,
      );
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
   * POS "Payment Link" — generate a hosted Stripe checkout URL for an
   * existing (unpaid) order, captured automatically so that when the
   * customer pays, the order flips straight to PAID (no staff Accept step).
   * The URL is shown as a QR / copyable link / SMS at the till. Reuses the
   * same brand-Connect direct-charge path as the storefront checkout.
   */
  async createOrderPaymentLink(
    tenantId: string,
    orderId: string,
  ): Promise<{ url: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        location: { select: { onlineOrderingSlug: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException("This order is already paid");
    }

    const origin = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(
      /\/+$/,
      "",
    );
    const slug = (order as any).location?.onlineOrderingSlug ?? null;
    const successUrl = slug
      ? `${origin}/order/${slug}/confirmation?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`
      : `${origin}/?paidOrderId=${order.id}`;
    const cancelUrl = slug ? `${origin}/order/${slug}` : origin;

    const { url } = await this.createCheckoutSession({
      tenantId,
      orderId,
      successUrl,
      cancelUrl,
      captureMethod: "automatic",
    });
    return { url };
  }

  /** True when the server can send SMS — lets the POS show/hide "Send SMS". */
  smsConfigured(): boolean {
    return this.sms.isConfigured();
  }

  /**
   * Ensure the order carries a short, unguessable payment code (stored on
   * metadata.paymentShortCode). It backs the tiny `/p/<code>` link we text so a
   * payment SMS fits in ONE Twilio segment (7p) instead of embedding the long
   * hosted Stripe URL, which spanned several segments. Idempotent: reuses the
   * existing code so re-texting/resending keeps the same link.
   */
  private async ensurePaymentShortCode(orderId: string): Promise<string> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, metadata: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    const meta = ((order.metadata as any) ?? {}) as Record<string, unknown>;
    const existing = (meta.paymentShortCode as string | undefined)?.trim();
    if (existing) return existing;

    // base62, ~8 chars → 62^8 ≈ 2e14 keyspace; retry on the vanishingly rare
    // collision so two live orders never share a code.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = randomBytes(8);
      code = Array.from(bytes, (b) => alphabet[b % 62]).join("");
      const clash = await this.prisma.order.findFirst({
        where: { metadata: { path: ["paymentShortCode"], equals: code } },
        select: { id: true },
      });
      if (!clash) break;
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: { metadata: { ...meta, paymentShortCode: code } as any },
    });
    return code;
  }

  /**
   * Public resolver for the texted short link `/p/<code>`. Looks the order up
   * by its short code (no auth — the code IS the credential, same as the hosted
   * link itself), then mints a fresh Stripe checkout URL so an expired session
   * never dead-ends the customer. Returns `{ paid: true }` if already settled.
   */
  async resolvePaymentLinkByCode(
    code: string,
  ): Promise<{ url?: string; paid?: boolean }> {
    const trimmed = (code ?? "").trim();
    if (!trimmed) throw new NotFoundException("Unknown payment link");
    const order = await this.prisma.order.findFirst({
      where: { metadata: { path: ["paymentShortCode"], equals: trimmed } },
      select: { id: true, tenantId: true, paymentStatus: true },
    });
    if (!order) throw new NotFoundException("Unknown payment link");
    if (order.paymentStatus === PaymentStatus.PAID) {
      return { paid: true };
    }
    const { url } = await this.createOrderPaymentLink(order.tenantId, order.id);
    return { url };
  }

  /**
   * Text the order's hosted payment link to the customer. Generates the link
   * (same as the QR/copy flow), then sends it via Twilio and meters the send
   * per restaurant. Throws a clear message if SMS isn't configured or the send
   * fails (e.g. a trial account texting an unverified number).
   */
  async sendOrderPaymentLinkSms(
    tenantId: string,
    orderId: string,
    phone: string,
    userId?: string,
  ): Promise<{ ok: true }> {
    const to = (phone ?? "").trim();
    if (!to) throw new BadRequestException("A customer phone number is required");

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, locationId: true, brandId: true, total: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Text a SHORT link (`/p/<code>`) that redirects to the hosted Stripe page,
    // not the long checkout URL itself. Combined with a GSM-7-only body (no em
    // dash / smart punctuation, which would force costly UCS-2 encoding), this
    // keeps the whole SMS inside ONE Twilio segment (7p) instead of the 9
    // segments the raw Stripe URL produced. The QR / copy-link modal still uses
    // the full URL (no per-character cost there).
    const code = await this.ensurePaymentShortCode(orderId);
    const origin = (
      process.env.WEB_URL ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
    const shortUrl = `${origin}/p/${code}`;
    const body = `Pay £${Number(order.total).toFixed(2)} for your order securely here: ${shortUrl}`;

    await this.sms.send({
      tenantId,
      to,
      body,
      purpose: "PAYMENT_LINK",
      locationId: order.locationId,
      brandId: (order as any).brandId ?? null,
      orderId: order.id,
      createdBy: userId ?? null,
    });
    return { ok: true };
  }

  /**
   * Restaurant accepted the order — capture the held authorization. Safe
   * to call for non-card orders (cash etc.); returns early if there's
   * nothing to capture.
   */
  /**
   * Resolve the connected-account ID a Payment was charged on, so
   * follow-up Stripe calls (capture / cancel / refund) use the same
   * direct-charge context. Falls back to the location's saved
   * Connect account if the Payment row pre-dates direct charges.
   * Public — TerminalService reuses this for the same reason (poll +
   * refund/cancel on a terminal-sourced Payment must hit the same
   * account the PaymentIntent actually lives on).
   */
  async stripeAccountForPayment(payment: any): Promise<string | null> {
    if (payment?.stripeConnectAccountId) {
      const row = await (this.prisma as any).stripeConnectAccount.findUnique({
        where: { id: payment.stripeConnectAccountId },
        select: { stripeAccountId: true },
      });
      if (row?.stripeAccountId) return row.stripeAccountId;
    }
    // Direct-charge created the PI on a connected account but our
    // Payment row may not be FK-linked (raw-acct_ id path). Look the
    // Order up and re-resolve through the location.
    const order = await (this.prisma as any).order.findUnique({
      where: { id: payment.orderId },
      // brandId is load-bearing. createCheckoutSession resolves the Connect
      // account WITH the order's brandId, so a brand that pasted its own
      // acct_… (brand-level escape hatch) has its Checkout Session created ON
      // that brand account. Re-resolving here WITHOUT brandId returned the
      // location/tenant account instead — so retrieve/capture/cancel/refund
      // hit the wrong account → "No such checkout.session" → card orders never
      // authorised and never appeared on the board.
      //
      // Terminal charges split further by CHANNEL:
      //   - S700 (physical counter reader): the reader is registered ONCE
      //     and reused across many later orders/brands, so it's fixed to
      //     ONE account resolved at the LOCATION level (no brandId) —
      //     re-resolving WITH brandId here could land on a DIFFERENT
      //     account than the one the reader/PI actually live on.
      //   - WisePad 3 / Tap to Pay (metadata.channel === "mobile_reader"):
      //     a fresh SDK connection is opened PER ORDER by the POS modal, so
      //     createConnectionToken/createMobileCharge both resolve WITH that
      //     order's brandId — re-resolving here must match, or a brand's
      //     own escape-hatch account never gets used for refund/cancel/poll.
      select: { tenantId: true, locationId: true, brandId: true },
    });
    if (!order) return null;
    const meta = (payment.metadata as any) ?? {};
    const isLocationFixedTerminal =
      meta.source === "terminal" && meta.channel !== "mobile_reader";
    const connect = await this.resolveConnectAccount(
      order.tenantId,
      order.locationId,
      isLocationFixedTerminal ? null : (order.brandId ?? null),
    );
    return connect?.stripeAccountId ?? null;
  }

  async captureForOrder(orderId: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) return;
    // Direct-charge mode: every Checkout Session, PaymentIntent,
    // capture / cancel / refund call must include the {stripeAccount}
    // option so it operates on the connected account where the charge
    // actually lives. Without it Stripe will look in the platform's
    // account and 404 ("No such payment_intent").
    const stripeAccount = await this.stripeAccountForPayment(payment);

    // Backfill the PaymentIntent ID if the webhook hasn't landed yet.
    let piId: string | null = payment.stripePaymentIntentId;
    if (!piId && this.stripe && stripeAccount) {
      const sessionId = payment.metadata?.stripeCheckoutSessionId as
        | string
        | undefined;
      if (sessionId) {
        try {
          const session = await this.stripe.checkout.sessions.retrieve(
            sessionId,
            { stripeAccount },
          );
          piId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null);
          if (piId) {
            await (this.prisma as any).payment.update({
              where: { id: payment.id },
              data: { stripePaymentIntentId: piId },
            });
          }
        } catch (err: any) {
          this.logger.warn(`Session lookup for capture backfill failed: ${err.message}`);
        }
      }
    }
    if (!piId) {
      this.logger.warn(
        `captureForOrder ${orderId}: no PaymentIntent yet — customer hasn't completed Stripe Checkout?`,
      );
      return;
    }
    if (
      payment.status === PaymentRecordStatus.SUCCEEDED ||
      payment.status === PaymentRecordStatus.REFUNDED ||
      payment.status === PaymentRecordStatus.CANCELLED
    ) {
      return; // already terminal
    }
    if (!this.stripe) return;
    if (!stripeAccount) {
      this.logger.error(
        `captureForOrder ${orderId}: couldn't resolve stripeAccount for direct-charge capture.`,
      );
      throw new BadRequestException(
        "Couldn't capture payment — no Stripe Connect account linked to this order.",
      );
    }
    try {
      await this.stripe.paymentIntents.capture(piId, undefined, {
        stripeAccount,
      });
      this.logger.log(
        `Stripe capture invoked for order ${orderId} (PI ${piId} on ${stripeAccount})`,
      );

      // Optimistic local flip. The payment_intent.succeeded webhook
      // would normally do this, but with direct charges the webhook
      // fires on the connected-account scope which the operator may
      // not have wired up. If it never arrives, Payment.status stays
      // PROCESSING — then a subsequent refund attempt incorrectly
      // routes through cancelAuthForOrder (because !== SUCCEEDED) and
      // Stripe rejects it ("PI status: succeeded, can't cancel"). The
      // capture call above just confirmed Stripe charged the customer,
      // so we know the truth — write it down. Webhook will be a no-op
      // when/if it does land.
      try {
        await (this.prisma as any).payment.update({
          where: { id: payment.id },
          data: { status: PaymentRecordStatus.SUCCEEDED },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { paymentStatus: "PAID" as any },
        });
      } catch (err: any) {
        this.logger.warn(
          `Optimistic capture flip failed for ${orderId}: ${err.message}`,
        );
      }
      // Phase LG — dashboard Logs page.
      this.events.emit("activity.log", {
        tenantId: payment.tenantId,
        category: "PAYMENTS",
        channel: "STRIPE",
        action: "payment.captured",
        status: "SUCCESS",
        message: `Payment captured for order (£${Number(payment.amount).toFixed(2)})`,
        details: { orderId, paymentIntentId: piId },
      });
    } catch (err: any) {
      this.logger.error(
        `Stripe capture failed for order ${orderId}: ${err.message}`,
      );
      this.events.emit("activity.log", {
        tenantId: payment.tenantId,
        category: "PAYMENTS",
        channel: "STRIPE",
        action: "payment.captured",
        status: "ERROR",
        message: `Stripe capture FAILED for order: ${err.message}`,
        details: { orderId, paymentIntentId: piId },
      });
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
    const stripeAccount = await this.stripeAccountForPayment(payment);
    if (!stripeAccount) {
      this.logger.error(
        `cancelAuthForOrder ${orderId}: no stripeAccount; direct-charge cancel impossible.`,
      );
      return;
    }
    try {
      await this.stripe.paymentIntents.cancel(
        payment.stripePaymentIntentId,
        { cancellation_reason: "requested_by_customer" },
        { stripeAccount },
      );
      this.logger.log(
        `Stripe PI cancelled for order ${orderId} on ${stripeAccount} (reason: ${reason ?? "n/a"})`,
      );
      // payment_intent.canceled webhook will flip statuses.
      // Phase LG — dashboard Logs page.
      this.events.emit("activity.log", {
        tenantId: payment.tenantId,
        category: "PAYMENTS",
        channel: "STRIPE",
        action: "payment.auth_released",
        status: "INFO",
        message: `Card hold released (order rejected before capture)${reason ? ` — ${reason}` : ""}`,
        details: { orderId, paymentIntentId: payment.stripePaymentIntentId },
      });
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
    if (!this.stripe) return;
    const stripeAccount = await this.stripeAccountForPayment(payment);
    if (!stripeAccount) {
      this.logger.error(
        `refundForOrder ${orderId}: no stripeAccount; direct-charge refund impossible.`,
      );
      return;
    }
    if (payment.status !== PaymentRecordStatus.SUCCEEDED) {
      // Local Payment row says not-captured-yet, but with direct-charge
      // webhooks routed to Connected-account scope our PROCESSING flag
      // may simply be stale. Ask Stripe directly before deciding
      // whether to cancel the auth or issue a refund — the wrong call
      // gets a 400 from Stripe and the customer keeps their money.
      try {
        const pi = await this.stripe.paymentIntents.retrieve(
          payment.stripePaymentIntentId,
          { stripeAccount },
        );
        if (pi.status === "succeeded") {
          // Already captured — fall through to the refund path.
        } else if (
          pi.status === "requires_capture" ||
          pi.status === "requires_payment_method" ||
          pi.status === "requires_confirmation" ||
          pi.status === "requires_action" ||
          pi.status === "processing"
        ) {
          return this.cancelAuthForOrder(orderId, reason);
        } else {
          // canceled / already-refunded / unknown — nothing to do.
          return;
        }
      } catch (err: any) {
        this.logger.warn(
          `refundForOrder PI lookup failed for ${orderId}: ${err.message} — falling back to local status`,
        );
        return this.cancelAuthForOrder(orderId, reason);
      }
    }
    try {
      const total = new Decimal(payment.amount).add(new Decimal(payment.tipAmount));
      await this.stripe.refunds.create(
        {
          payment_intent: payment.stripePaymentIntentId,
          amount: Math.round(total.toNumber() * 100),
          reason: "requested_by_customer",
          metadata: { orderId, reason: reason ?? "" },
        },
        { stripeAccount },
      );
      this.logger.log(
        `Stripe refund created for order ${orderId} on ${stripeAccount} (PI ${payment.stripePaymentIntentId})`,
      );
      // Optimistic local flip — same reasoning as capture above.
      // Don't rely on charge.refunded webhook (Connected-account scope).
      try {
        await (this.prisma as any).payment.update({
          where: { id: payment.id },
          data: { status: PaymentRecordStatus.REFUNDED },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { paymentStatus: "REFUNDED" as any },
        });
      } catch (err: any) {
        this.logger.warn(
          `Optimistic refund flip failed for ${orderId}: ${err.message}`,
        );
      }
      // Phase LG — dashboard Logs page.
      this.events.emit("activity.log", {
        tenantId: payment.tenantId,
        category: "PAYMENTS",
        channel: "STRIPE",
        action: "payment.refunded",
        status: "WARNING",
        message: `Payment refunded (£${total.toFixed(2)})${reason ? ` — ${reason}` : ""}`,
        details: { orderId, paymentIntentId: payment.stripePaymentIntentId },
      });
    } catch (err: any) {
      this.logger.error(`Stripe refund failed for order ${orderId}: ${err.message}`);
      this.events.emit("activity.log", {
        tenantId: payment.tenantId,
        category: "PAYMENTS",
        channel: "STRIPE",
        action: "payment.refunded",
        status: "ERROR",
        message: `Stripe refund FAILED: ${err.message}`,
        details: { orderId, paymentIntentId: payment.stripePaymentIntentId },
      });
      throw new BadRequestException(`Refund failed: ${err.message}`);
    }
  }

  /**
   * Reconcile a CARD order's payment status directly against Stripe.
   *
   * Belt-and-braces for the webhook path: with direct charges the
   * PaymentIntent lives on the CONNECTED account, so Stripe events
   * fire on the "Connected accounts" scope. If the operator's webhook
   * endpoint is only listening to platform-scope events the
   * authorisation event never reaches us — paymentStatus stays
   * PENDING, the storefront stays on "Processing your order…", and
   * the staff Orders board never lights up.
   *
   * The storefront's polling loop on /v1/ordering/orders/:id/status
   * calls this opportunistically. We fetch the Checkout Session live
   * (with stripeAccount option) and, if the customer has paid,
   * synthesise the same effect markAuthorized() would have had from a
   * real webhook: flip paymentStatus to AUTHORIZED, broadcast the
   * new-order socket event so the staff board renders the card.
   *
   * Best-effort and idempotent — safe to call on every poll.
   */
  async reconcileOrderPayment(orderId: string): Promise<void> {
    if (!this.stripe) return;
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) return;
    if (payment.status !== PaymentRecordStatus.PENDING) return;

    const sessionId = (payment.metadata as any)?.stripeCheckoutSessionId;

    const stripeAccount = await this.stripeAccountForPayment(payment);
    if (!stripeAccount) return;

    // Embedded storefront payments have no Checkout Session — the Payment
    // Element confirms a PaymentIntent directly — so retrieve that instead.
    // Bailing on the missing session id would switch this safety net off
    // for precisely the orders that need it most: money already taken, and
    // the connected-account webhook (which is why we poll at all) missing.
    if (!sessionId) {
      if (!payment.stripePaymentIntentId) return;
      let pi: any;
      try {
        pi = await this.stripe.paymentIntents.retrieve(
          payment.stripePaymentIntentId,
          {},
          { stripeAccount },
        );
      } catch (err: any) {
        this.logger.warn(
          `reconcileOrderPayment: PI retrieve failed for ${orderId}: ${err.message}`,
        );
        return;
      }
      // Captured outright, so this is PAID, not merely authorised — the
      // same route the succeeded webhook takes for automatic capture.
      if (pi.status === "succeeded") {
        await this.confirmPayment(payment.tenantId, pi.id);
      } else if (pi.status === "requires_capture") {
        await this.markAuthorized(pi);
      } else if (pi.status === "canceled") {
        await this.markCancelled(pi);
      }
      return;
    }

    let session: any;
    try {
      session = await this.stripe.checkout.sessions.retrieve(
        sessionId,
        { expand: ["payment_intent"] },
        { stripeAccount },
      );
    } catch (err: any) {
      this.logger.warn(
        `reconcileOrderPayment: session retrieve failed for ${orderId}: ${err.message}`,
      );
      return;
    }

    const pi = session?.payment_intent;
    if (!pi || typeof pi === "string") return;

    // requires_capture = authorised, waiting for staff Accept → manual
    //                    capture. This is the success path for
    //                    manual-capture Checkout sessions.
    // succeeded         = already captured (shouldn't happen pre-Accept
    //                    but handle it gracefully).
    // canceled          = customer cancelled, refund, or 3DS failed.
    if (pi.status === "requires_capture" || pi.status === "succeeded") {
      await this.markAuthorized(pi);
    } else if (pi.status === "canceled") {
      await this.markCancelled(pi);
    }
  }

  /**
   * Resolve a Payment row from a PaymentIntent webhook event, even
   * when our Payment row was created BEFORE the PI existed.
   *
   * Stripe Checkout Sessions don't issue the PaymentIntent ID until
   * the customer actually completes payment, so our createCheckout-
   * Session code persisted Payment.stripePaymentIntentId = null. By
   * the time payment_intent.amount_capturable_updated fires, we
   * still don't have a row matching the PI id directly. Fall back to
   * the orderId we stashed in the PI's metadata at session-create
   * time, then backfill the PI id onto the Payment row so all
   * subsequent webhooks (succeeded, canceled, charge.refunded) find
   * it by the fast path.
   */
  private async findPaymentForPi(pi: any): Promise<any | null> {
    if (!pi?.id) return null;
    let payment = await (this.prisma as any).payment.findFirst({
      where: { stripePaymentIntentId: pi.id },
    });
    if (payment) return payment;
    const orderId = pi.metadata?.orderId as string | undefined;
    if (!orderId) return null;
    payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, method: "CARD" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) return null;
    // Backfill — first time we've seen the real PI for this Payment.
    try {
      await (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: pi.id },
      });
      payment.stripePaymentIntentId = pi.id;
    } catch (err: any) {
      this.logger.warn(`Payment PI backfill failed: ${err.message}`);
    }
    return payment;
  }

  /**
   * Webhook handler — Stripe authorization succeeded. The Order joins the
   * staff board now (with paymentStatus AUTHORIZED) so the restaurant
   * can accept or reject it.
   */
  async markAuthorized(pi: any): Promise<void> {
    const payment = await this.findPaymentForPi(pi);
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

    // The new-order socket broadcast was suppressed at create time for
    // unpaid CARD orders. Emit it now so the staff Orders board lights
    // up the moment Stripe authorises the hold.
    const order = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      include: { items: { select: { quantity: true } } },
    });
    if (order && order.locationId) {
      this.socket.emitNewOrder(order.locationId, {
        orderId: order.id,
        tenantId: order.tenantId,
        locationId: order.locationId,
        platform: order.platform,
        orderSource: order.orderSource,
        fulfillmentType: order.fulfillmentType,
        displayId: order.displayId,
        status: order.status,
        total: Number(order.total),
        itemCount: order.items.reduce(
          (sum, i) => sum + (i.quantity ?? 0),
          0,
        ),
        customerName: order.customerName,
        scheduledFor: order.scheduledFor?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
      } as any);
    }

    this.socket.emitToTenant(payment.tenantId, "order:updated" as any, {
      orderId: payment.orderId,
      paymentStatus: "AUTHORIZED",
    } as any);

    // Phase LG — dashboard Logs page.
    this.events.emit("activity.log", {
      tenantId: payment.tenantId,
      locationId: order?.locationId ?? null,
      brandId: (order as any)?.brandId ?? null,
      category: "PAYMENTS",
      channel: "STRIPE",
      action: "payment.authorized",
      status: "SUCCESS",
      message: `Card authorised for order ${order?.displayId ?? payment.orderId} (£${Number(payment.amount).toFixed(2)})`,
      details: { orderId: payment.orderId },
    });

    // Card is now authorised. Two paths:
    //
    //  • Order ALREADY accepted (e.g. a WhatsApp order is visible on the board
    //    pre-payment, and an operator accepted it before the card authorised —
    //    or auto-accept fired earlier). The accept-time captureForOrder() had
    //    nothing to capture back then, and maybeAutoAccept won't re-fire on an
    //    already-accepted order — so capture NOW, or the money stays held.
    //
    //  • Order still PENDING → emit payment.authorized so the location's
    //    auto-accept setting kicks in (OrdersService listens → maybeAutoAccept
    //    → updateStatus(ACCEPTED) → captureForOrder). If auto-accept is off it
    //    stays PENDING and capture happens when staff tap Accept.
    const ACCEPTED_STATES = [
      "ACCEPTED",
      "PREPARING",
      "READY",
      "OUT_FOR_DELIVERY",
      "COMPLETED",
    ];
    // Always announce authorisation. Listeners:
    //  • WhatsAppNotifyService → sends the customer a "payment received" msg
    //    (so when the wa.me redirect drops them back in the chat they see it).
    //  • OrdersService → runs the location's auto-accept (no-op if the order
    //    is already accepted), which captures + prints.
    if (order?.locationId) {
      this.events.emit("payment.authorized", {
        orderId: payment.orderId,
        tenantId: payment.tenantId,
        locationId: order.locationId,
      });
    }
    // If the order was already accepted before the card authorised, the
    // accept-time capture had nothing to capture and auto-accept won't re-fire
    // — so capture now. (For still-PENDING orders the auto-accept path above
    // captures on accept instead. captureForOrder is idempotent.)
    if (order && ACCEPTED_STATES.includes(order.status as string)) {
      await this.captureForOrder(payment.orderId).catch((err: any) =>
        this.logger.error(
          `capture-on-authorize failed for ${payment.orderId}: ${err.message}`,
        ),
      );
    }
  }

  /**
   * Webhook handler — Stripe authorization cancelled (we called cancel(),
   * or Stripe auto-released a stale hold). Mark Payment and Order
   * accordingly.
   */
  async markCancelled(pi: any): Promise<void> {
    const payment = await this.findPaymentForPi(pi);
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

  // PLATFORM_ADMIN + TENANT_OWNER see the whole tenant's ledger. OWNER and
  // FINANCIAL_AGENT are scoped to their assigned locations (direct + brand).
  private async ledgerAccessibleLocationIds(
    tenantId: string,
    userId?: string,
    role?: string,
  ): Promise<string[] | null> {
    if (!userId || !role || role === "PLATFORM_ADMIN" || role === "TENANT_OWNER") {
      return null;
    }
    const [locs, brands] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locs.map((l: any) => l.locationId as string));
    const brandIds = brands.map((b: any) => b.brandId as string);
    if (brandIds.length) {
      const brandRows = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brandRows) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  async getLedger(tenantId: string, opts: GetLedgerOpts = {}) {
    const { startDate, endDate, limit = 50, offset = 0 } = opts;

    const where: any = { tenantId };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    // Location scoping for non-tenant-wide roles: only ledger entries whose
    // payment's order is at an accessible location.
    const allowed = await this.ledgerAccessibleLocationIds(tenantId, opts.userId, opts.role);
    if (allowed) {
      if (allowed.length === 0) return { data: [], total: 0, limit, offset };
      where.payment = { order: { locationId: { in: allowed } } };
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

  /**
   * Phase AP-8 — per-location Stripe Connect onboarding.
   *
   * Creates an Express Connect account for the restaurant if one
   * doesn't exist yet (stored in StripeConnectAccount with the
   * matching locationId) and returns a Stripe-hosted onboarding URL.
   * The restaurant fills in business details, bank account, KYC, etc.
   * on Stripe — Stripe enables the `transfers` capability once they
   * pass underwriting — and the `account.updated` webhook flips
   * chargesEnabled / payoutsEnabled in our DB automatically.
   *
   * Distinct from createConnectOnboardingLink (tenant-scoped) so a
   * platform with multiple restaurants per tenant can give each a
   * separate payout account.
   */
  async createLocationConnectOnboardingLink(
    tenantId: string,
    locationId: string,
    options: { returnPath?: string; refreshPath?: string } = {},
  ): Promise<{ url: string; accountId: string }> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, name: true },
    });
    if (!location) {
      throw new NotFoundException("Location not found");
    }

    let account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, locationId },
    });

    // First-time onboarding for this location → create the Express
    // account on Stripe and our DB row.
    if (!account) {
      let stripeAccountId = `mock_acct_${locationId.slice(0, 8)}`;
      if (this.stripe) {
        try {
          const stripeAccount = await this.stripe.accounts.create({
            type: "express",
            country: "GB",
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            business_profile: { name: location.name },
            metadata: { tenantId, locationId, locationName: location.name },
          });
          stripeAccountId = stripeAccount.id;
        } catch (err: any) {
          this.logger.error(
            `Stripe Connect account create failed for location ${locationId}: ${err.message}`,
          );
          throw new BadRequestException(
            `Couldn't start Stripe onboarding: ${err.message}`,
          );
        }
      }
      account = await (this.prisma as any).stripeConnectAccount.create({
        data: {
          tenantId,
          locationId,
          stripeAccountId,
          accountType: "EXPRESS",
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingComplete: false,
        },
      });
      // Mirror the acct_… ID onto the Location row so the existing
      // resolveConnectAccount tiered lookup finds it instantly even
      // before the first account.updated webhook lands.
      await this.prisma.location.update({
        where: { id: locationId },
        data: { stripeConnectedAccountId: stripeAccountId },
      });
    }

    const webBase = (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
    const refreshUrl = `${webBase}${options.refreshPath ?? `/dashboard/locations?connect=refresh&locationId=${locationId}`}`;
    const returnUrl = `${webBase}${options.returnPath ?? `/dashboard/locations?connect=complete&locationId=${locationId}`}`;

    let onboardingUrl = `https://connect.stripe.com/setup/mock/${account.stripeAccountId}`;
    if (this.stripe) {
      try {
        const link = await this.stripe.accountLinks.create({
          account: account.stripeAccountId,
          refresh_url: refreshUrl,
          return_url: returnUrl,
          type: "account_onboarding",
        });
        onboardingUrl = link.url;
      } catch (err: any) {
        this.logger.error(`Stripe account link create failed: ${err.message}`);
        throw new BadRequestException(
          `Couldn't generate onboarding link: ${err.message}`,
        );
      }
    }

    return { url: onboardingUrl, accountId: account.stripeAccountId };
  }

  // ── Phase AW-30 — per-brand Stripe Connect with embedded onboarding ──
  //
  // The legacy hosted-link flow (createLocationConnectOnboardingLink)
  // is kept for backwards compatibility; new tenants use the embedded
  // components rendered on the /dashboard/payments page. Each brand
  // gets its own Express account so a tenant with multiple virtual
  // brands can settle each one separately. Application fees still flow
  // through PaymentIntent.application_fee_amount unchanged.

  private async ensureBrandConnectAccount(
    tenantId: string,
    brandId: string,
    actingUserId?: string,
  ) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        country: true,
        stripeConnectedAccountId: true,
      },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    let account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, brandId },
    });

    if (!account) {
      let stripeAccountId =
        brand.stripeConnectedAccountId?.trim() ||
        `mock_acct_${brandId.slice(0, 8)}`;

      // If the brand has no acct_ yet, create one on Stripe with the
      // brand details pre-filled so the operator's form is half-done
      // before they ever see it.
      if (this.stripe && !brand.stripeConnectedAccountId) {
        try {
          // Phase AW-30 — pre-fill the email so Stripe skips its
          // "Let's get started" screen. Falls back to the brand's
          // tenant owner if the acting user isn't around (e.g. when
          // the call comes from a background job). Pre-filling
          // `company: { address }` is intentionally NOT done — that
          // would force us to declare `business_type` ahead of time
          // and we don't know whether the merchant is a sole trader
          // or a company until the embedded form asks them.
          let prefillEmail: string | undefined;
          if (actingUserId) {
            const u = await (this.prisma as any).user.findUnique({
              where: { id: actingUserId },
              select: { email: true },
            });
            prefillEmail = u?.email ?? undefined;
          }
          if (!prefillEmail) {
            const owner = await (this.prisma as any).user.findFirst({
              where: { tenantId, role: "TENANT_OWNER" },
              select: { email: true },
            });
            prefillEmail = owner?.email ?? undefined;
          }

          const stripeAccount = await this.stripe.accounts.create({
            type: "express",
            country: brand.country || "GB",
            email: prefillEmail,
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            business_profile: {
              name: brand.name,
              support_phone: brand.phone || undefined,
            },
            metadata: { tenantId, brandId, brandName: brand.name },
          });
          stripeAccountId = stripeAccount.id;
        } catch (err: any) {
          this.logger.error(
            `Brand Connect account create failed for ${brandId}: ${err.message}`,
          );
          throw new BadRequestException(
            `Couldn't create Stripe account: ${err.message}`,
          );
        }
      }

      account = await (this.prisma as any).stripeConnectAccount.create({
        data: {
          tenantId,
          brandId,
          stripeAccountId,
          accountType: "EXPRESS",
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingComplete: false,
        },
      });

      // Mirror the acct_… onto the brand so resolveConnectAccount
      // already returns this account on the next checkout.
      if (!brand.stripeConnectedAccountId) {
        await (this.prisma as any).brand.update({
          where: { id: brandId },
          data: { stripeConnectedAccountId: stripeAccountId },
        });
      }
    }

    return account;
  }

  /**
   * Embedded onboarding — returns an AccountSession client_secret the
   * web `<ConnectAccountOnboarding />` component consumes. The merchant
   * fills the form inside our dashboard rather than on stripe.com.
   */
  async createBrandOnboardingSession(
    tenantId: string,
    brandId: string,
    actingUserId?: string,
  ) {
    const account = await this.ensureBrandConnectAccount(
      tenantId,
      brandId,
      actingUserId,
    );
    if (!this.stripe) {
      return {
        stripeAccountId: account.stripeAccountId,
        clientSecret: `mock_cs_onboard_${account.stripeAccountId}`,
        mock: true,
      };
    }
    try {
      const session = await this.stripe.accountSessions.create({
        account: account.stripeAccountId,
        components: {
          account_onboarding: { enabled: true },
        },
      });
      return {
        stripeAccountId: account.stripeAccountId,
        clientSecret: session.client_secret,
      };
    } catch (err: any) {
      this.logger.error(
        `Stripe AccountSession (onboarding) failed for brand ${brandId}: ${err.message}`,
      );
      throw new BadRequestException(
        `Couldn't open onboarding: ${err.message}`,
      );
    }
  }

  /**
   * Embedded management — same idea, but for the
   * `<ConnectAccountManagement />` + `<ConnectPayouts />` panels the
   * merchant uses to change bank details or check payout schedule
   * after they're already onboarded.
   */
  async createBrandManagementSession(
    tenantId: string,
    brandId: string,
    actingUserId?: string,
  ) {
    const account = await this.ensureBrandConnectAccount(
      tenantId,
      brandId,
      actingUserId,
    );
    if (!this.stripe) {
      return {
        stripeAccountId: account.stripeAccountId,
        clientSecret: `mock_cs_manage_${account.stripeAccountId}`,
        mock: true,
      };
    }
    try {
      const session = await this.stripe.accountSessions.create({
        account: account.stripeAccountId,
        components: {
          account_management: { enabled: true },
          payouts: { enabled: true },
          notification_banner: { enabled: true },
        },
      });
      return {
        stripeAccountId: account.stripeAccountId,
        clientSecret: session.client_secret,
      };
    } catch (err: any) {
      this.logger.error(
        `Stripe AccountSession (management) failed for brand ${brandId}: ${err.message}`,
      );
      throw new BadRequestException(
        `Couldn't open management panel: ${err.message}`,
      );
    }
  }

  /**
   * List every brand in the tenant with its Connect status so the
   * Payments page can render one card per brand.
   *
   * When `locationId` is passed, only brands tied to that location
   * show up:
   *   - the location's parent kitchen brand (Location.brandId), AND
   *   - any virtual brand pinned to it via Brand.primaryLocationId.
   * Brands that haven't enabled direct online ordering yet are
   * filtered out — there's nothing to take payment for, so the
   * payments page hides them.
   */
  async listBrandConnectStatus(tenantId: string, locationId?: string) {
    const baseWhere: any = {
      tenantId,
      deletedAt: null,
      directOrderingEnabled: true,
    };

    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, brand: { tenantId } },
        select: { id: true, brandId: true },
      });
      if (!loc) return [];
      baseWhere.OR = [
        { id: loc.brandId },
        { primaryLocationId: loc.id },
      ];
    }

    const brands = await this.prisma.brand.findMany({
      where: baseWhere,
      select: {
        id: true,
        name: true,
        logoUrl: true,
        stripeConnectedAccountId: true,
        applicationFeeMode: true,
        applicationFeeFixedAmount: true,
        applicationFeePercentage: true,
      },
      orderBy: { name: "asc" },
    });
    const accounts = await (this.prisma as any).stripeConnectAccount.findMany({
      where: { tenantId, brandId: { not: null } },
    });
    const byBrandId = new Map<string, any>();
    for (const a of accounts) byBrandId.set(a.brandId, a);

    return brands.map((b) => {
      const a = byBrandId.get(b.id);
      return {
        brandId: b.id,
        name: b.name,
        logoUrl: b.logoUrl,
        stripeAccountId: a?.stripeAccountId ?? b.stripeConnectedAccountId ?? null,
        chargesEnabled: a?.chargesEnabled ?? false,
        payoutsEnabled: a?.payoutsEnabled ?? false,
        onboardingComplete: a?.onboardingComplete ?? false,
        applicationFee: {
          mode: b.applicationFeeMode,
          fixedAmount: b.applicationFeeFixedAmount,
          percentage: b.applicationFeePercentage,
        },
      };
    });
  }

  /** Refresh Stripe-side capability flags into our DB row. */
  async refreshBrandConnectStatus(tenantId: string, brandId: string) {
    const account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, brandId },
    });
    if (!account) return { connected: false };
    if (!this.stripe) {
      return {
        connected: true,
        stripeAccountId: account.stripeAccountId,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        onboardingComplete: account.onboardingComplete,
      };
    }
    try {
      const fresh = await this.stripe.accounts.retrieve(account.stripeAccountId);
      const updated = await (this.prisma as any).stripeConnectAccount.update({
        where: { id: account.id },
        data: {
          chargesEnabled: !!fresh.charges_enabled,
          payoutsEnabled: !!fresh.payouts_enabled,
          onboardingComplete: !!fresh.details_submitted,
        },
      });
      return {
        connected: true,
        stripeAccountId: updated.stripeAccountId,
        chargesEnabled: updated.chargesEnabled,
        payoutsEnabled: updated.payoutsEnabled,
        onboardingComplete: updated.onboardingComplete,
      };
    } catch (err: any) {
      this.logger.warn(
        `refreshBrandConnectStatus retrieve failed for ${brandId}: ${err.message}`,
      );
      return {
        connected: true,
        stripeAccountId: account.stripeAccountId,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        onboardingComplete: account.onboardingComplete,
      };
    }
  }

  /** Returns the current Connect status for a location's account. */
  async getLocationConnectStatus(tenantId: string, locationId: string) {
    const account = await (this.prisma as any).stripeConnectAccount.findFirst({
      where: { tenantId, locationId },
    });
    if (!account) {
      return { connected: false };
    }
    return {
      connected: true,
      stripeAccountId: account.stripeAccountId,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      onboardingComplete: account.onboardingComplete,
    };
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

    await this.dispatchStripeEvent(event);
    return { received: true };
  }

  /**
   * Dispatch an ALREADY-VERIFIED Stripe event to the right handler. Split out
   * of handleStripeWebhook so the billing webhook controller — which owns the
   * /api/v1/webhooks/stripe route Stripe actually posts connected-account
   * payment events to — can forward them here. Without this,
   * payment_intent.amount_capturable_updated never reaches markAuthorized and
   * card orders never appear on the board to accept/reject.
   */
  async dispatchStripeEvent(event: any): Promise<void> {
    this.logger.log(`Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const tenantId = pi.metadata?.tenantId;
        // SMS wallet top-up (not an order payment) — credit the prepaid balance
        // and stop; there's no Order/Payment row to confirm. Idempotent on PI id.
        if (pi.metadata?.purpose === "wallet_topup") {
          await this.wallet.creditFromStripePi(pi).catch((err: any) =>
            this.logger.error(`wallet top-up credit failed: ${err.message}`),
          );
          break;
        }
        // Card-present (Terminal) charges capture immediately → mark PAID.
        // Online charges keep their hold→AUTHORIZED→capture flow.
        if (pi.metadata?.source === "terminal") {
          await this.settleTerminalPi(pi).catch((err: any) =>
            this.logger.error(`settleTerminalPi via webhook failed: ${err.message}`),
          );
        } else if (tenantId) {
          // Automatic-capture flows (POS Payment Link) fire succeeded with
          // no prior amount_capturable_updated, so our Payment row still has
          // a null PI id. Resolve + backfill it from the order metadata first
          // so confirmPayment's PI lookup finds the row and flips it to PAID.
          // No-op for the online flow (markAuthorized already backfilled).
          await this.findPaymentForPi(pi).catch(() => null);
          await this.confirmPayment(tenantId, pi.id).catch((err: any) =>
            this.logger.error(`confirmPayment via webhook failed: ${err.message}`),
          );
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const tenantId = pi.metadata?.tenantId;
        // Surface WHY the card failed (decline code + message) so a "processing
        // error occurred" on the customer's screen is diagnosable from our logs.
        const lpe = pi.last_payment_error ?? {};
        this.logger.warn(
          `Stripe payment_failed PI ${pi.id} (order ${pi.metadata?.orderId ?? "?"}, acct ${event.account ?? "platform"}): ` +
            `code=${lpe.code ?? "?"} decline=${lpe.decline_code ?? "-"} type=${lpe.type ?? "?"} msg="${lpe.message ?? "?"}"`,
        );
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
        await this.markAuthorized(pi).catch((err: any) =>
          this.logger.error(`markAuthorized failed: ${err.message}`),
        );
        break;
      }

      case "payment_intent.canceled": {
        // Either we called cancel() because staff rejected the order, or
        // Stripe auto-cancelled a stale uncaptured auth. Either way the
        // customer sees nothing on their statement.
        const pi = event.data.object;
        await this.markCancelled(pi).catch((err: any) =>
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
  }
}
