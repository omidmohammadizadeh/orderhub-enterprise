import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WalletService } from "../wallet/wallet.service";
import {
  defaultSmsFrom,
  isSmsConfigured,
  sendSmsViaProvider,
  smsConfigHint,
  smsProvider,
} from "./sms-provider";

export type SmsPurpose = "PAYMENT_LINK" | "MARKETING" | "OTHER";

export interface SendSmsArgs {
  tenantId: string;
  to: string;
  body: string;
  purpose: SmsPurpose;
  locationId?: string | null;
  brandId?: string | null;
  orderId?: string | null;
  campaignId?: string | null;
  createdBy?: string | null;
  // Bill the tenant's prepaid wallet (default true). Set false only for
  // system/internal sends we don't charge for.
  bill?: boolean;
}

// Map the send purpose to the wallet ledger purpose.
const WALLET_PURPOSE: Record<SmsPurpose, string> = {
  PAYMENT_LINK: "SMS_PAYMENT_LINK",
  MARKETING: "SMS_MARKETING",
  OTHER: "SMS_OTHER",
};

/**
 * Single billable SMS send path. Every message we send on a tenant's behalf
 * (payment links, marketing) goes through here so it's:
 *   1. sent via whichever provider SMS_PROVIDER names (see sms-provider.ts),
 *      and
 *   2. logged to sms_messages — the per-restaurant usage ledger the
 *      pass-through billing totals from.
 * Message bodies are NOT stored (privacy); only recipient + purpose + segments.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  /** True when the active provider's credentials are set, so the operator UI
   *  can offer SMS. */
  isConfigured(): boolean {
    return isSmsConfigured();
  }

  async send(args: SendSmsArgs): Promise<{ ok: true; sid?: string; segments: number }> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        `SMS isn't set up yet. Add your ${smsProvider()} credentials (${smsConfigHint()}) to enable sending.`,
      );
    }

    // Prepaid-wallet gate: refuse a billable send the balance can't cover BEFORE
    // calling the provider, so we never pay for a text the tenant hasn't funded.
    const bill = args.bill !== false;
    if (bill) {
      await this.wallet.assertCanAffordSms(args.tenantId, args.body, args.locationId);
    }

    const from = await this.resolveFrom(args);

    try {
      // Segment counting is the provider's, not ours: Twilio's num_segments
      // and Telnyx's parts mean the same thing, so the wallet bills the same
      // either way.
      const sent = await sendSmsViaProvider({
        to: args.to,
        from,
        body: args.body,
      });
      const segments = sent.segments;
      const smsMessageId = await this.log(args, {
        status: "SENT",
        providerSid: sent.id,
        segments,
      });
      // Charge the wallet. Never throws — the message already went out; a debit
      // failure is logged only.
      //
      // Payment-link texts are billed at a FLAT single segment (7p): the
      // customer-facing product is "7p per payment link". A hosted Stripe
      // checkout URL is long enough to span several segments, so
      // charging per actual segment would over-bill the restaurant (a single
      // link came out at 9 segments / 63p). We still record the true segment
      // count on the SmsMessage row for our own cost tracking. Marketing texts
      // remain per-segment (their length is controlled by the operator).
      if (bill) {
        const billedSegments = args.purpose === "PAYMENT_LINK" ? 1 : segments;
        await this.wallet.debitForSms({
          tenantId: args.tenantId,
          segments: billedSegments,
          purpose: WALLET_PURPOSE[args.purpose],
          smsMessageId,
          locationId: args.locationId ?? null,
          createdBy: args.createdBy ?? null,
        });
      }
      return { ok: true, sid: sent.id, segments };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      await this.log(args, { status: "FAILED", error: String(err?.message ?? err).slice(0, 500) });
      throw new BadRequestException(`SMS failed: ${err?.message ?? err}`);
    }
  }

  /**
   * The "From" for a send, resolved per LOCATION so each client texts from
   * their OWN number/name. Falls back to the provider's shared sender
   * (TWILIO_FROM / TELNYX_FROM).
   *
   * Per-location config lives on Location.settings (no migration):
   *   smsSenderName — alphanumeric sender ID (≤11 chars), shows the shop name.
   *   smsNumber     — the shop's own E.164 number.
   *
   * Hybrid rule so marketing stays STOP-compliant:
   *  - MARKETING → the location's NUMBER only (never an alphanumeric name — a
   *    name-only sender is one-way, so a customer's "STOP" can never reach us).
   *    Falls back to the shared number, which DOES process STOP via the webhook.
   *  - PAYMENT_LINK / OTHER → the sender NAME if set (branding, no reply needed),
   *    else the location's number, else the shared number.
   */
  private async resolveFrom(args: SendSmsArgs): Promise<string> {
    const globalFrom = defaultSmsFrom();
    if (!args.locationId) return globalFrom;
    let name = "";
    let number = "";
    try {
      const loc = await this.prisma.location.findUnique({
        where: { id: args.locationId },
        select: { settings: true },
      });
      const s = (loc?.settings ?? {}) as Record<string, unknown>;
      name = typeof s.smsSenderName === "string" ? s.smsSenderName.trim() : "";
      number = typeof s.smsNumber === "string" ? s.smsNumber.trim() : "";
    } catch (e: any) {
      this.logger.warn(
        `SMS sender resolve failed for location ${args.locationId}: ${e?.message ?? e}`,
      );
    }
    if (args.purpose === "MARKETING") return number || globalFrom;
    return name || number || globalFrom;
  }

  private async log(
    args: SendSmsArgs,
    meta: { status: string; providerSid?: string; segments?: number; error?: string },
  ): Promise<string | null> {
    try {
      const row = await (this.prisma as any).smsMessage.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId ?? null,
          brandId: args.brandId ?? null,
          orderId: args.orderId ?? null,
          campaignId: args.campaignId ?? null,
          toNumber: args.to,
          purpose: args.purpose,
          segments: meta.segments ?? 1,
          provider: smsProvider(),
          providerSid: meta.providerSid ?? null,
          status: meta.status,
          error: meta.error ?? null,
          createdBy: args.createdBy ?? null,
        },
        select: { id: true },
      });
      return row.id as string;
    } catch (e: any) {
      // Never let a metering-log failure break the actual send.
      this.logger.warn(`sms_messages log failed: ${e?.message ?? e}`);
      return null;
    }
  }
}
