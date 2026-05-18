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
