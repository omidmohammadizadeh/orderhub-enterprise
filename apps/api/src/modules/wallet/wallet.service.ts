import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { isSmsConfigured } from "../sms/sms-provider";

// Stripe is loaded lazily (mirrors subscriptions.service / billing) so a missing
// key never crashes boot — FREE_PILOT tenants may not have Stripe on day 1.
let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  Stripe = null;
}

// Platform sell price per SMS segment (pence). Twilio's published UK rate is
// $0.056/message (~5.6p at parity), so 10p leaves a healthy margin (payment
// links are 1 segment via the short link). The sell price is deliberately NOT
// tied to the provider: switching to a cheaper carrier widens the margin
// rather than changing what a restaurant pays. Override globally with env
// SMS_PRICE_PER_SEGMENT_MINOR, or per wallet with
// wallets.smsPricePerSegmentMinor.
const DEFAULT_PRICE_PER_SEGMENT_MINOR = 10; // 10p per segment

// Platform sell price per ANSWERED AI phone call (pence). Our own cost is
// roughly 15p for a three-minute call (telephony + speech-to-text + Claude +
// text-to-speech), so £1 is a ~6x margin — and on a £25 order it is 4% of order
// value, against 14–30% for the delivery aggregators the shop is comparing us
// to. Override globally with VOICE_PRICE_PER_CALL_MINOR, or per wallet with
// wallets.voicePricePerCallMinor (founding-customer pricing).
const DEFAULT_VOICE_PRICE_PER_CALL_MINOR = 100; // £1 per answered call

export interface WalletSummary {
  balanceMinor: number;
  currency: string;
  pricePerSegmentMinor: number;
  voicePricePerCallMinor: number;
  lowBalanceThresholdMinor: number;
  lowBalance: boolean;
  smsConfigured: boolean;
  /** Answered AI calls this balance still covers. null if voice is free. */
  callsRemaining: number | null;
  autoTopup: {
    enabled: boolean;
    thresholdMinor: number;
    amountMinor: number;
    cardOnFile: boolean;
    failedAt: Date | null;
    failureReason: string | null;
  };
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
    return isSmsConfigured();
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
    const voiceRate = this.voicePricePerCallMinor(wallet);
    return {
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency,
      pricePerSegmentMinor: rate,
      voicePricePerCallMinor: voiceRate,
      lowBalanceThresholdMinor: wallet.lowBalanceThresholdMinor,
      lowBalance: wallet.balanceMinor < wallet.lowBalanceThresholdMinor,
      smsConfigured: this.smsConfigured(),
      // How many more calls this balance answers. The number the operator
      // actually wants when the AI is live — "£4.20" means nothing, "4 more
      // calls" means top up now.
      callsRemaining: voiceRate > 0 ? Math.floor(wallet.balanceMinor / voiceRate) : null,
      autoTopup: {
        enabled: !!wallet.autoTopupEnabled,
        thresholdMinor: wallet.autoTopupThresholdMinor,
        amountMinor: wallet.autoTopupAmountMinor,
        cardOnFile: !!wallet.stripePaymentMethodId,
        // A declined card is the quiet killer — it must reach the operator's
        // screen, because the symptom is a phone that stops being answered.
        failedAt: wallet.autoTopupFailedAt ?? null,
        failureReason: wallet.autoTopupFailureReason ?? null,
      },
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

  // ── AI voice receptionist ───────────────────────────────────────────────
  //
  // Billed PER ANSWERED CALL, not per minute. Two reasons, and both matter:
  // our own cost is per conversation-turn rather than per second, so a per-
  // minute price would be passing on a number that doesn't reflect what we pay;
  // and we control how long the call lasts, so per-minute billing would charge
  // the shop more whenever our agent is slow. A shop that spots that incentive
  // never trusts the bill again.

  /** Platform default price per answered call (pennies). £1. */
  voicePricePerCallMinor(wallet?: { voicePricePerCallMinor?: number | null } | null): number {
    const raw = this.config.get<string>("VOICE_PRICE_PER_CALL_MINOR");
    const n = raw ? parseInt(raw, 10) : NaN;
    const platform = Number.isFinite(n) && n >= 0 ? n : DEFAULT_VOICE_PRICE_PER_CALL_MINOR;
    return wallet?.voicePricePerCallMinor ?? platform;
  }

  /**
   * A call is only billable if the AI actually did something for the shop.
   * A wrong number that hangs up after three seconds must never cost £1 — that
   * is the argument you only have to lose once. The rule lives here, in one
   * place, and is shown to the operator on the dashboard verbatim.
   */
  static readonly MIN_BILLABLE_SECONDS = 10;

  isBillableCall(call: { status?: string | null; durationSeconds?: number | null }): boolean {
    if (call.status !== "COMPLETED" && call.status !== "TRANSFERRED") return false;
    return (call.durationSeconds ?? 0) >= WalletService.MIN_BILLABLE_SECONDS;
  }

  /**
   * THE gate: may the AI pick up this call?
   *
   * Deliberately returns a verdict instead of throwing — the telephony webhook
   * has to make an answer/don't-answer decision in milliseconds, and an
   * exception is the wrong shape for "the shop is out of credit".
   *
   * Not answering is a SAFE failure. The AI sits behind forward-on-no-answer,
   * so a call we decline simply keeps ringing at the shop, exactly as it did
   * before the AI existed. We degrade to the old world; we never eat the call.
   *
   * Tries auto top-up inline before refusing — that is the whole point of
   * holding a card on file, and it is the difference between a shop losing
   * their AI at 8pm on a Friday and never noticing anything happened.
   */
  async canAnswerVoiceCall(
    tenantId: string,
    locationId: string | null,
  ): Promise<{ ok: boolean; reason?: string; balanceMinor: number; priceMinor: number }> {
    let wallet = await this.getOrCreate(tenantId, locationId);
    const price = this.voicePricePerCallMinor(wallet);

    if (wallet.balanceMinor >= price) {
      // Already fine — but if we're near the floor, refill in the background so
      // the NEXT call doesn't have to wait on Stripe.
      if (wallet.balanceMinor < (wallet.autoTopupThresholdMinor ?? 0)) {
        void this.tryAutoTopup(wallet).catch(() => undefined);
      }
      return { ok: true, balanceMinor: wallet.balanceMinor, priceMinor: price };
    }

    // Below the price. Last chance: charge the saved card and re-read.
    const topped = await this.tryAutoTopup(wallet).catch(() => null);
    if (topped) wallet = topped;

    if (wallet.balanceMinor >= price) {
      return { ok: true, balanceMinor: wallet.balanceMinor, priceMinor: price };
    }
    return {
      ok: false,
      reason: "NO_FUNDS",
      balanceMinor: wallet.balanceMinor,
      priceMinor: price,
    };
  }

  /**
   * Charge for one completed call. Idempotent at the DATABASE level via the
   * unique index on walletTransaction.voiceCallId — provider webhooks retry,
   * and "one call, one charge" has to be true even when our code runs twice.
   *
   * Never throws into the call path: the conversation already happened.
   */
  async debitForVoiceCall(args: {
    tenantId: string;
    locationId: string | null;
    voiceCallId: string;
    durationSeconds: number;
    status: string;
  }): Promise<{ chargedMinor: number } | null> {
    if (!this.isBillableCall(args)) {
      this.logger.log(
        `Voice call ${args.voiceCallId} not billable (${args.status}, ${args.durationSeconds}s)`,
      );
      return null;
    }
    try {
      const wallet = await this.getOrCreate(args.tenantId, args.locationId);
      const cost = this.voicePricePerCallMinor(wallet);
      const result = await this.prisma.$transaction(async (tx: any) => {
        // Create the ledger row FIRST. If this call was already charged, the
        // unique index rejects it here and we abort before touching the
        // balance — the ordering is what makes double-billing impossible.
        await tx.walletTransaction.create({
          data: {
            tenantId: args.tenantId,
            walletId: wallet.id,
            type: "DEBIT",
            amountMinor: -cost,
            // Filled in below once we know the post-debit balance.
            balanceAfterMinor: 0,
            currency: wallet.currency,
            purpose: "VOICE_CALL",
            voiceCallId: args.voiceCallId,
            locationId: args.locationId ?? null,
            description: `AI phone call (${args.durationSeconds}s) @ ${cost}p`,
          },
        });
        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceMinor: { decrement: cost } },
        });
        await tx.walletTransaction.updateMany({
          where: { voiceCallId: args.voiceCallId },
          data: { balanceAfterMinor: updated.balanceMinor },
        });
        await tx.voiceCall.update({
          where: { id: args.voiceCallId },
          data: { billedMinor: cost, billedAt: new Date() },
        });
        return updated;
      });
      // Below the floor after this call — refill now rather than on the next
      // ring, so the top-up latency never lands inside a customer's call.
      if (result.balanceMinor < (wallet.autoTopupThresholdMinor ?? 0)) {
        void this.tryAutoTopup(wallet).catch(() => undefined);
      }
      return { chargedMinor: cost };
    } catch (e: any) {
      // A unique-constraint violation here is the happy path for a retried
      // webhook: the call was already charged. Anything else is a real error.
      if (e?.code === "P2002") {
        this.logger.log(`Voice call ${args.voiceCallId} already billed — skipping`);
        return null;
      }
      this.logger.error(
        `Voice call debit failed for ${args.voiceCallId}: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  // ── Auto top-up ─────────────────────────────────────────────────────────

  /** Don't fire two auto top-ups inside this window. A bug or a burst of calls
   *  must not be able to drain the operator's card. */
  private static readonly AUTO_TOPUP_COOLDOWN_MS = 5 * 60_000;

  /**
   * Charge the saved card off-session and credit the wallet. Returns the
   * updated wallet on success, null when it didn't (or shouldn't) run.
   *
   * A failure here is recorded on the wallet, not just logged: a declined card
   * means the phone stops being answered, and the operator has to be able to
   * SEE that on the dashboard rather than discover it from a customer.
   */
  async tryAutoTopup(wallet: any): Promise<any | null> {
    if (!wallet?.autoTopupEnabled) return null;
    if (!wallet.stripePaymentMethodId || !wallet.stripeCustomerId) return null;
    if (!this.stripe) return null;
    const last = wallet.autoTopupLastAt ? new Date(wallet.autoTopupLastAt).getTime() : 0;
    if (Date.now() - last < WalletService.AUTO_TOPUP_COOLDOWN_MS) return null;

    const amount = Math.max(500, wallet.autoTopupAmountMinor ?? 2000);

    // Stamp the attempt BEFORE calling Stripe. If the process dies mid-charge,
    // the cooldown still holds and we can't double-charge on restart.
    await this.db().wallet.update({
      where: { id: wallet.id },
      data: { autoTopupLastAt: new Date() },
    });

    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount,
          currency: (wallet.currency ?? "GBP").toLowerCase(),
          customer: wallet.stripeCustomerId,
          payment_method: wallet.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          description: "OrderHub wallet auto top-up",
          metadata: {
            tenantId: wallet.tenantId,
            walletId: wallet.id,
            locationId: wallet.locationId ?? "",
            autoTopup: "true",
          },
        },
        { idempotencyKey: `auto-topup-${wallet.id}-${Math.floor(Date.now() / 60_000)}` },
      );
      if (pi.status !== "succeeded") {
        throw new Error(`payment intent ${pi.status}`);
      }
      // Reuse the same credit path as a manual top-up so there is exactly one
      // place that turns money into balance.
      await this.creditFromStripePi(pi);
      await this.db().wallet.update({
        where: { id: wallet.id },
        data: { autoTopupFailedAt: null, autoTopupFailureReason: null },
      });
      this.logger.log(
        `Auto top-up ${amount}p succeeded for wallet ${wallet.id} (tenant ${wallet.tenantId})`,
      );
      return this.db().wallet.findUnique({ where: { id: wallet.id } });
    } catch (e: any) {
      const reason =
        e?.raw?.message ?? e?.message ?? "Card declined";
      await this.db()
        .wallet.update({
          where: { id: wallet.id },
          data: { autoTopupFailedAt: new Date(), autoTopupFailureReason: String(reason).slice(0, 300) },
        })
        .catch(() => undefined);
      this.logger.error(`Auto top-up failed for wallet ${wallet.id}: ${reason}`);
      return null;
    }
  }

  /** Operator-facing auto top-up settings. Enabling without a saved card is
   *  refused rather than silently useless — the card comes from a top-up. */
  async setAutoTopup(
    tenantId: string,
    locationId: string | null,
    input: { enabled: boolean; thresholdMinor?: number; amountMinor?: number },
  ): Promise<any> {
    const wallet = await this.getOrCreate(tenantId, locationId);
    if (input.enabled && !wallet.stripePaymentMethodId) {
      throw new BadRequestException(
        "Add a card first — top up once and tick “save this card”, then auto top-up can be switched on.",
      );
    }
    const threshold = input.thresholdMinor ?? wallet.autoTopupThresholdMinor;
    const amount = input.amountMinor ?? wallet.autoTopupAmountMinor;
    if (amount < 500) {
      throw new BadRequestException("Minimum auto top-up is £5.");
    }
    if (threshold < 0 || threshold > 50_000) {
      throw new BadRequestException("Auto top-up trigger must be between £0 and £500.");
    }
    return this.db().wallet.update({
      where: { id: wallet.id },
      data: {
        autoTopupEnabled: input.enabled,
        autoTopupThresholdMinor: threshold,
        autoTopupAmountMinor: amount,
        ...(input.enabled ? { autoTopupFailedAt: null, autoTopupFailureReason: null } : {}),
      },
    });
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
        // Keep the card on file so auto top-up can charge it later without the
        // operator present. Without this the whole auto top-up feature is dead
        // on arrival — there is nothing to charge — and the phone goes quiet
        // the first time a wallet empties out of hours.
        setup_future_usage: "off_session",
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

    // Remember the card. setup_future_usage on the Checkout Session means
    // Stripe has attached it to the customer; storing the id here is what makes
    // auto top-up possible on every later refill. Best-effort — a top-up must
    // never fail because we couldn't save a card for next time.
    const savedPm =
      (typeof pi?.payment_method === "string" ? pi.payment_method : pi?.payment_method?.id) ??
      null;
    if (savedPm && pi?.metadata?.walletId) {
      await this.db()
        .wallet.update({
          where: { id: pi.metadata.walletId },
          data: { stripePaymentMethodId: savedPm },
        })
        .catch((e: any) =>
          this.logger.warn(`Could not save card for wallet ${pi.metadata.walletId}: ${e?.message}`),
        );
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
