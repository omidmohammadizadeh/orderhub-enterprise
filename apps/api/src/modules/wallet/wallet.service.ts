import {
  BadRequestException,
  ForbiddenException,
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

  /**
   * Fetch (or lazily create) a wallet for (tenant, location). Each location
   * funds its own SMS; locationId null = the tenant-wide wallet.
   */
  async getOrCreate(tenantId: string, locationId?: string | null): Promise<any> {
    const loc = locationId ?? null;
    const existing = await this.db().wallet.findFirst({ where: { tenantId, locationId: loc } });
    if (existing) return existing;
    return this.db().wallet.create({ data: { tenantId, locationId: loc } });
  }

  // ── Per-user location access ────────────────────────────────────────────
  // PLATFORM_ADMIN + TENANT_OWNER see every location's wallet. OWNER and
  // FINANCIAL_AGENT are scoped to the locations assigned to them, so one
  // location's finance user can NEVER view, fund, or spend another location's
  // SMS credits. Mirrors SubscriptionsService.
  private static readonly TENANT_WIDE = ["PLATFORM_ADMIN", "TENANT_OWNER"];

  /** null = every location (tenant-wide role); array = the scoped allowlist. */
  private async accessibleLocationIds(
    tenantId: string,
    userId?: string,
    role?: string,
  ): Promise<string[] | null> {
    if (!userId || !role || WalletService.TENANT_WIDE.includes(role)) return null;
    const [locs, brands] = await Promise.all([
      this.db().userLocation.findMany({ where: { userId }, select: { locationId: true } }),
      this.db().userBrand.findMany({ where: { userId }, select: { brandId: true } }),
    ]);
    const ids = new Set<string>(locs.map((l: any) => l.locationId as string));
    const brandIds = brands.map((b: any) => b.brandId as string);
    if (brandIds.length) {
      const brandRows = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brandRows) {
        if ((b as any).primaryLocationId) ids.add((b as any).primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  /** Throw unless the user may touch this location's wallet. Scoped users are
   *  also denied the tenant-wide (locationId null) wallet. */
  async assertLocationAccess(
    tenantId: string,
    locationId: string | null | undefined,
    userId?: string,
    role?: string,
  ): Promise<void> {
    const allowed = await this.accessibleLocationIds(tenantId, userId, role);
    if (allowed && (locationId == null || !allowed.includes(locationId))) {
      throw new ForbiddenException(
        "You don't have access to this location's SMS wallet.",
      );
    }
  }

  async getSummary(tenantId: string, locationId?: string | null): Promise<WalletSummary> {
    const wallet = await this.getOrCreate(tenantId, locationId);
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

  async listTransactions(tenantId: string, locationId?: string | null, limit = 50): Promise<any[]> {
    const where: any = { tenantId };
    if (locationId !== undefined) where.locationId = locationId ?? null;
    return this.db().walletTransaction.findMany({
      where,
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
  async assertCanAffordSms(
    tenantId: string,
    body: string,
    locationId?: string | null,
  ): Promise<void> {
    const wallet = await this.getOrCreate(tenantId, locationId);
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
      const wallet = await this.getOrCreate(args.tenantId, args.locationId);
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

  // ── Dispatch (courier) fee ──────────────────────────────────────────────

  /** Flat OrderHub fee (pennies) charged to the location wallet per courier
   *  dispatch. Overridable via DISPATCH_FEE_MINOR; defaults to 50p. */
  dispatchFeeMinor(): number {
    const n = parseInt(
      this.config.get<string>("DISPATCH_FEE_MINOR") ?? "50",
      10,
    );
    return Number.isFinite(n) && n >= 0 ? n : 50;
  }

  /** Throw (402-style) unless the location wallet can cover a dispatch fee.
   *  Called BEFORE we create the courier job so a broke wallet blocks dispatch
   *  cleanly. PLATFORM_ADMIN bypass lives in the caller, not here. */
  async assertCanAffordDispatch(
    tenantId: string,
    locationId: string | null,
    amountMinor?: number,
  ): Promise<void> {
    const cost = amountMinor ?? this.dispatchFeeMinor();
    const wallet = await this.getOrCreate(tenantId, locationId);
    if (wallet.balanceMinor < cost) {
      throw new BadRequestException(
        "Dispatch wallet balance is too low. Top up your wallet to dispatch this order.",
      );
    }
  }

  /** Atomically debit the dispatch fee + append a ledger row. Throws if the
   *  balance can't cover it (checked inside the same read the update uses).
   *  Returns the fee taken and the resulting balance. */
  async debitForDispatch(args: {
    tenantId: string;
    locationId: string | null;
    orderId: string;
    amountMinor?: number;
    createdBy?: string | null;
  }): Promise<{ chargedMinor: number; balanceAfterMinor: number }> {
    const cost = args.amountMinor ?? this.dispatchFeeMinor();
    const wallet = await this.getOrCreate(args.tenantId, args.locationId);
    if (wallet.balanceMinor < cost) {
      throw new BadRequestException(
        "Dispatch wallet balance is too low. Top up your wallet to dispatch this order.",
      );
    }
    const updated = await this.prisma.$transaction(async (tx: any) => {
      const u = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { decrement: cost } },
      });
      await tx.walletTransaction.create({
        data: {
          tenantId: args.tenantId,
          walletId: wallet.id,
          type: "DEBIT",
          amountMinor: -cost,
          balanceAfterMinor: u.balanceMinor,
          currency: wallet.currency,
          purpose: "DISPATCH_FEE",
          orderId: args.orderId,
          locationId: args.locationId ?? null,
          createdBy: args.createdBy ?? null,
          description: `Courier dispatch fee (${cost}p)`,
        },
      });
      return u;
    });
    return { chargedMinor: cost, balanceAfterMinor: updated.balanceMinor };
  }

  /** Credit a previously-charged dispatch fee back (courier job creation failed
   *  after we debited). Best-effort — logged, never thrown into the caller. */
  async refundDispatch(args: {
    tenantId: string;
    locationId: string | null;
    orderId: string;
    amountMinor: number;
    createdBy?: string | null;
  }): Promise<void> {
    try {
      const wallet = await this.getOrCreate(args.tenantId, args.locationId);
      await this.prisma.$transaction(async (tx: any) => {
        const u = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceMinor: { increment: args.amountMinor } },
        });
        await tx.walletTransaction.create({
          data: {
            tenantId: args.tenantId,
            walletId: wallet.id,
            type: "REFUND",
            amountMinor: args.amountMinor,
            balanceAfterMinor: u.balanceMinor,
            currency: wallet.currency,
            purpose: "DISPATCH_FEE",
            orderId: args.orderId,
            locationId: args.locationId ?? null,
            createdBy: args.createdBy ?? null,
            description: `Dispatch fee refund (job failed)`,
          },
        });
      });
    } catch (e: any) {
      this.logger.error(
        `Dispatch fee refund failed for order ${args.orderId}: ${e?.message ?? e}`,
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
    locationId?: string | null,
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

    const wallet = await this.getOrCreate(tenantId, locationId);

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
          locationId: wallet.locationId ?? "",
          createdBy: userId ?? "",
        },
      },
      metadata: {
        purpose: "wallet_topup",
        tenantId,
        walletId: wallet.id,
        locationId: wallet.locationId ?? "",
      },
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

    // Credit the EXACT wallet the top-up was started for (walletId is stamped on
    // the PI). Falls back to resolving by (tenant, location) metadata.
    const walletId = pi?.metadata?.walletId as string | undefined;
    const wallet = walletId
      ? await this.db().wallet.findUnique({ where: { id: walletId } })
      : await this.getOrCreate(tenantId, pi?.metadata?.locationId || null);
    if (!wallet) {
      this.logger.warn(`wallet_topup PI ${pi.id}: wallet ${walletId} not found — skipping`);
      return;
    }
    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { increment: amount } },
      });
      await tx.walletTransaction.create({
        data: {
          tenantId,
          walletId: wallet.id,
          locationId: wallet.locationId ?? null,
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
