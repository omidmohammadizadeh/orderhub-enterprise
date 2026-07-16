import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export type SmsPurpose = "PAYMENT_LINK" | "MARKETING" | "OTHER";

export interface SendSmsArgs {
  tenantId: string;
  to: string;
  body: string;
  purpose: SmsPurpose;
  locationId?: string | null;
  brandId?: string | null;
  orderId?: string | null;
  createdBy?: string | null;
}

/**
 * Single billable SMS send path. Every message we send on a tenant's behalf
 * (payment links, marketing) goes through here so it's:
 *   1. sent via Twilio, and
 *   2. logged to sms_messages — the per-restaurant usage ledger the
 *      pass-through billing totals from.
 * Message bodies are NOT stored (privacy); only recipient + purpose + segments.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** True when Twilio credentials are set so the operator UI can offer SMS. */
  isConfigured(): boolean {
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

  async send(args: SendSmsArgs): Promise<{ ok: true; sid?: string; segments: number }> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        "SMS isn't set up yet. Add your Twilio credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM) to enable sending.",
      );
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;
    const from = process.env.TWILIO_FROM!;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const payload = new URLSearchParams({ To: args.to, From: from, Body: args.body });
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: payload.toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        // Surface Twilio's own message ("The number is unverified" on trial,
        // "not a valid phone number", etc.) so the operator sees why.
        let msg = `Twilio HTTP ${res.status}`;
        try {
          msg = JSON.parse(text)?.message ?? msg;
        } catch {
          /* keep default */
        }
        await this.log(args, { status: "FAILED", error: msg.slice(0, 500) });
        throw new BadRequestException(`SMS failed: ${msg}`);
      }
      const json = JSON.parse(text) as { sid?: string; num_segments?: string };
      const segments = Number(json.num_segments) || 1;
      await this.log(args, { status: "SENT", providerSid: json.sid, segments });
      return { ok: true, sid: json.sid, segments };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      await this.log(args, { status: "FAILED", error: String(err?.message ?? err).slice(0, 500) });
      throw new BadRequestException(`SMS failed: ${err?.message ?? err}`);
    }
  }

  private async log(
    args: SendSmsArgs,
    meta: { status: string; providerSid?: string; segments?: number; error?: string },
  ): Promise<void> {
    try {
      await (this.prisma as any).smsMessage.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId ?? null,
          brandId: args.brandId ?? null,
          orderId: args.orderId ?? null,
          toNumber: args.to,
          purpose: args.purpose,
          segments: meta.segments ?? 1,
          provider: process.env.SMS_PROVIDER ?? "TWILIO",
          providerSid: meta.providerSid ?? null,
          status: meta.status,
          error: meta.error ?? null,
          createdBy: args.createdBy ?? null,
        },
      });
    } catch (e: any) {
      // Never let a metering-log failure break the actual send.
      this.logger.warn(`sms_messages log failed: ${e?.message ?? e}`);
    }
  }
}
