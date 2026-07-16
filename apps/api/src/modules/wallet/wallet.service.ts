import {
  BadRequestException,
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Stripe is loaded lazily (mirrors subscriptions.service / billing) so a missing
// key never crashes boot — FREE_PILOT tenants may not have Stripe on day 1.
let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  Stripe = null;
}

const DEFAULT_PRICE_PER_SEGMENT_MINOR = 7; // 7p per Twilio segment

export interface WalletSummary {
  balanceMinor: number;
  currency: string;
  pricePerSegmentMinor: number;
  lowBalanceThresholdMinor: number;
  lowBalance: boolean;
  smsConfigured: boolean;
}

/**
 * Prepaid SMS wallet. Restaurants top up a GBP balance up front and every
 * billable SMS debits it per Twilio segment, so OrderHub never fronts Twilio
 * costs. Balances are integer pennies to avoid float drift.
 *
 * @Global (see WalletModule) so SmsService and PaymentsService can inject it
 * without creating module import cycles. Depends only on Prisma + Config, and
 * builds its own Stripe client for top-up Checkout Sessions.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly stripe: any | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    this.stripe = key && Stripe ? new Stripe(key, { apiVersion: "2024-06-20" }) : null;
  }

  private db(): any {
    return this.prisma as any;
  }

  private webBase(): string {
    return (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
  }

  private platformDefaultRate(): number {
    const raw = this.config.get<string>("SMS_PRICE_PER_SEGMENT_MINOR");
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRICE_PER_SEGMENT_MINOR;
  }

  /** The effective per-segment price for a wallet (override → platform default). */
  pricePerSegment(wallet: { smsPricePerSegmentMinor?: number | null } | null): number {
    return wallet?.smsPricePerSegmentMinor ?? this.platformDefaultRate();
  }

  private smsConfigured(): boolean {
    const provider = process.env.SMS_PROVIDER ?? "TWILIO";
    if (provider === "TWILIO") {
      return !!(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM
      );
    }
    if (provider === "VONAGE") {
      return !!(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET);
    }
    return false;
  }

  /** Fetch (or lazily create) the tenant's wallet row. */
  async getOrCreate(tenantId: string): Promise<any> {
    const existing = await this.db().wallet.findUnique({ where: { tenantId } });
    if (existing) return existing;
    return this.db().wallet.create({ data: { tenantId } });
  }

  async getSummary(tenantId: string): Promise<WalletSummary> {
    const wallet = await this.getOrCreate(tenantId);
    const rate = this.pricePerSegment(wallet);
    return {
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency,
      pricePerSegmentMinor: rate,
      lowBalanceThresholdMinor: wallet.lowBalanceThresholdMinor,
      lowBalance: wallet.balanceMinor < wallet.lowBalanceThresholdMinor,
      smsConfigured: this.smsConfigured(),
    };
  }

  async listTransactions(tenantId: string, limit = 50): Promise<any[]> {
    return this.db().walletTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /**
   * Estimate how many SMS segments a body will use, WITHOUT sending — so we can
   * refuse a send the wallet can't cover before spending money at Twilio. This
   * mirrors Twilio's GSM-7 vs UCS-2 split; the real charge later uses Twilio's
   * reported num_segments, so a small estimate error only affects the gate.
   */
  estimateSegments(body: string): number {
    const text = body ?? "";
    // GSM-7 basic + extension charset. Anything outside → the whole message is
    // encoded as UCS-2 (e.g. an emoji or a “smart quote”).
    const gsm7 =
      "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    const gsm7Ext = "^{}\\[~]|€";
    let isGsm = true;
    let unitLen = 0; // GSM length counting extension chars as 2 units
    for (const ch of text) {
      if (gsm7.includes(ch)) {
        unitLen += 1;
      } else if (gsm7Ext.includes(ch)) {
        unitLen += 2;
      } else {
        isGsm = false;
        break;
      }
    }
    if (isGsm) {
      if (unitLen <= 160) return 1;
      return Math.ceil(unitLen / 153); // 7-char UDH per concatenated part
    }
    // UCS-2: count UTF-16 code units.
    const codeUnits = text.length;
    if (codeUnits <= 70) return 1;
    return Math.ceil(codeUnits / 67);
  }

  /**
   * Throw if the wallet can't cover an SMS of the given body. Called BEFORE we
   * hit Twilio so a send with no funds fails cleanly (operator sees a "top up"
   * message) rather than us paying for it.
   */
  async assertCanAffordSms(tenantId: string, body: string): Promise<void> {
    const wallet = await this.getOrCreate(tenantId);
    const rate = this.pricePerSegment(wallet);
    const estCost = this.estimateSegments(body) * rate;
    if (wallet.balanceMinor < estCost) {
      throw new BadRequestException(
        "Your SMS wallet balance is too low to send this text. Top up your wallet to continue.",
      );
    }
  }

  /**
   * Debit the wallet for a sent SMS. Runs in a transaction: decrement balance
   * and append a signed ledger row atomically. Never throws into the send path —
   * the message already went out, so a debit failure is logged, not surfaced.
   */
  async debitForSms(args: {
    tenantId: string;
    segments: number;
    purpose: string; // SMS_PAYMENT_LINK | SMS_MARKETING | SMS_OTHER
    smsMessageId?: string | null;
    locationId?: string | null;
    createdBy?: string | null;
  }): Promise<void> {
    try {
      const wallet = await this.getOrCreate(args.tenantId);
      const rate = this.pricePerSegment(wallet);
      const cost = Math.max(args.segments, 1) * rate;
      await this.prisma.$transaction(async (tx: any) => {
        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceMinor: { decrement: cost } },
        });
        await tx.walletTransaction.create({
          data: {
            tenantId: args.tenantId,
            walletId: wallet.id,
            type: "DEBIT",
            amountMinor: -cost,
            balanceAfterMinor: updated.balanceMinor,
            currency: wallet.currency,
            purpose: args.purpose,
            segments: args.segments,
            smsMessageId: args.smsMessageId ?? null,
            locationId: args.locationId ?? null,
            createdBy: args.createdBy ?? null,
            description: `SMS ${args.segments} segment(s) @ ${rate}p`,
          },
        });
      });
    } catch (e: any) {
      this.logger.error(
        `Wallet debit failed for tenant ${args.tenantId}: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Start a top-up: a one-off Stripe Checkout Session (mode: payment) on the
   * PLATFORM account. Returns a URL the operator opens to pay by card. The
   * balance is credited only when Stripe confirms via webhook (creditFromStripePi).
   */
  async startTopup(
    tenantId: string,
    amountMinor: number,
    userId?: string,
  ): Promise<{ url: string }> {
    if (!Number.isInteger(amountMinor) || amountMinor < 500) {
      throw new BadRequestException("Minimum top-up is £5.");
    }
    if (amountMinor > 100_000) {
      throw new BadRequestException("Maximum single top-up is £1,000.");
    }
    if (!this.stripe) {
      throw new InternalServerErrorException(
        "Card payments aren't configured on the server (missing STRIPE_SECRET_KEY).",
      );
    }

    const wallet = await this.getOrCreate(tenantId);

    // Reuse (or lazily create) a platform Stripe customer for this tenant.
    let stripeCustomerId = wallet.stripeCustomerId as string | null;
    if (!stripeCustomerId) {
      const tenant = await this.db().tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const customer = await this.stripe.customers.create({
        name: tenant?.name ?? "OrderHub tenant",
        metadata: { tenantId, purpose: "sms_wallet" },
      });
      stripeCustomerId = customer.id;
      await this.db().wallet.update({
        where: { id: wallet.id },
        data: { stripeCustomerId },
      });
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      client_reference_id: tenantId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: amountMinor,
            product_data: {
              name: "SMS wallet top-up",
              description: "Prepaid balance for sending payment links & marketing texts",
            },
          },
        },
      ],
      // metadata is copied onto the PaymentIntent so the webhook can identify
      // this as a wallet top-up (vs an order payment) and credit the balance.
      payment_intent_data: {
        metadata: {
          purpose: "wallet_topup",
          tenantId,
          walletId: wallet.id,
          createdBy: userId ?? "",
        },
      },
      metadata: { purpose: "wallet_topup", tenantId, walletId: wallet.id },
      success_url: `${this.webBase()}/dashboard/wallet?topup=success`,
      cancel_url: `${this.webBase()}/dashboard/wallet?topup=cancel`,
    });

    return { url: session.url as string };
  }

  /**
   * Credit the wallet from a succeeded top-up PaymentIntent (called by the
   * Stripe webhook). Idempotent: keyed on the PI id, so Stripe retries and
   * duplicate deliveries never double-credit.
   */
  async creditFromStripePi(pi: any): Promise<void> {
    const tenantId = pi?.metadata?.tenantId;
    const amount = Number(pi?.amount_received ?? pi?.amount ?? 0);
    if (!tenantId || amount <= 0) {
      this.logger.warn(
        `wallet_topup PI ${pi?.id} missing tenantId/amount — skipping credit`,
      );
      return;
    }

    const already = await this.db().walletTransaction.findFirst({
      where: { stripePaymentIntentId: pi.id, type: "TOPUP" },
      select: { id: true },
    });
    if (already) {
      this.logger.debug(`wallet_topup PI ${pi.id} already credited — skipping`);
      return;
    }

    const wallet = await this.getOrCreate(tenantId);
    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { increment: amount } },
      });
      await tx.walletTransaction.create({
        data: {
          tenantId,
          walletId: wallet.id,
          type: "TOPUP",
          amountMinor: amount,
          balanceAfterMinor: updated.balanceMinor,
          currency: (pi.currency ?? "gbp").toUpperCase(),
          purpose: "TOPUP",
          stripePaymentIntentId: pi.id,
          stripeCheckoutId: pi?.metadata?.checkoutId ?? null,
          createdBy: pi?.metadata?.createdBy || null,
          description: `Top-up £${(amount / 100).toFixed(2)}`,
        },
      });
    });
    this.logger.log(
      `Wallet credited £${(amount / 100).toFixed(2)} for tenant ${tenantId} (PI ${pi.id})`,
    );
  }
}
