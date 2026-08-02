// Which company actually puts the text on the network.
//
// One file so the provider decision lives in exactly one place: SmsService
// (billable sends) and NotificationsService (system sends) both come through
// here, and switching provider is one env var — SMS_PROVIDER — with no code
// change and no redeploy of anything else. That reversibility is the point:
// a messaging provider is judged on delivery rates and real invoices, neither
// of which you can know before sending live traffic.
//
// UK notes that drive the shapes below:
//   • Alphanumeric sender IDs ("PIZZAUNO") need no registration in the UK, so
//     a shop's branded sender is just a string — no 10DLC, that's US-only.
//   • A name-only sender is ONE-WAY. Marketing must go from a real number or
//     a customer's STOP can never reach us. SmsService.resolveFrom enforces
//     that; this layer just sends what it's given.
//   • Telnyx requires messaging_profile_id whenever `from` is alphanumeric.

import { Logger } from "@nestjs/common";

export type SmsProviderName = "TWILIO" | "TELNYX" | "VONAGE";

export interface SmsSendResult {
  /** The provider's own id for the message, stored for reconciliation. */
  id?: string;
  /** Billable message parts. Both Twilio and Telnyx report this per send. */
  segments: number;
  /** Provider-reported cost, when it gives one (Telnyx does; Twilio doesn't). */
  cost?: { amount: number; currency: string } | null;
}

/** Carries the provider's own wording — "the number is unverified", etc. */
export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly provider: SmsProviderName,
  ) {
    super(message);
    this.name = "SmsProviderError";
  }
}

const logger = new Logger("SmsProvider");

export function smsProvider(): SmsProviderName {
  const raw = (process.env.SMS_PROVIDER ?? "TWILIO").trim().toUpperCase();
  return raw === "TELNYX" || raw === "VONAGE" ? raw : "TWILIO";
}

/** True when this provider has everything it needs to send. */
export function isSmsConfigured(): boolean {
  switch (smsProvider()) {
    case "TELNYX":
      return !!(process.env.TELNYX_API_KEY && process.env.TELNYX_FROM);
    case "VONAGE":
      return !!(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET);
    default:
      return !!(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM
      );
  }
}

/** What to send from when a location hasn't set its own sender. */
export function defaultSmsFrom(): string {
  switch (smsProvider()) {
    case "TELNYX":
      return process.env.TELNYX_FROM ?? "";
    case "VONAGE":
      return process.env.VONAGE_FROM ?? "OrderHub";
    default:
      return process.env.TWILIO_FROM ?? "";
  }
}

/** The env vars an operator is missing, for the "SMS isn't set up" message. */
export function smsConfigHint(): string {
  switch (smsProvider()) {
    case "TELNYX":
      return "TELNYX_API_KEY / TELNYX_FROM (and TELNYX_MESSAGING_PROFILE_ID if you send from a sender name)";
    case "VONAGE":
      return "VONAGE_API_KEY / VONAGE_API_SECRET";
    default:
      return "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM";
  }
}

export async function sendSmsViaProvider(args: {
  to: string;
  from: string;
  body: string;
}): Promise<SmsSendResult> {
  switch (smsProvider()) {
    case "TELNYX":
      return sendViaTelnyx(args);
    case "VONAGE":
      return sendViaVonage(args);
    default:
      return sendViaTwilio(args);
  }
}

// ── Twilio ─────────────────────────────────────────────────────────────────

async function sendViaTwilio(args: {
  to: string;
  from: string;
  body: string;
}): Promise<SmsSendResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        To: args.to,
        From: args.from,
        Body: args.body,
      }).toString(),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    let msg = `Twilio HTTP ${res.status}`;
    try {
      msg = JSON.parse(text)?.message ?? msg;
    } catch {
      /* non-JSON body — keep the status line */
    }
    throw new SmsProviderError(msg, "TWILIO");
  }
  const json = JSON.parse(text) as { sid?: string; num_segments?: string };
  return { id: json.sid, segments: Number(json.num_segments) || 1, cost: null };
}

// ── Telnyx ─────────────────────────────────────────────────────────────────
//
// POST https://api.telnyx.com/v2/messages, Bearer auth, JSON in and out.
// Success: { data: { id, parts, cost: { amount, currency }, to: [...] } }
// Failure: { errors: [{ code, title, detail }] }
//
// `parts` is Telnyx's segment count — the same thing Twilio calls
// num_segments, so the wallet bills identically whichever provider is on.

async function sendViaTelnyx(args: {
  to: string;
  from: string;
  body: string;
}): Promise<SmsSendResult> {
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();
  const payload: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    text: args.body,
  };
  // Required whenever `from` is a sender name rather than a number, and
  // harmless when it isn't — so always send it if we have one.
  if (profileId) payload.messaging_profile_id = profileId;

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    // Telnyx's `detail` is the human sentence ("The from number … is not
    // assigned to a messaging profile"); title is the generic category.
    let msg = `Telnyx HTTP ${res.status}`;
    try {
      const err = JSON.parse(text)?.errors?.[0];
      if (err) msg = err.detail ?? err.title ?? msg;
    } catch {
      /* non-JSON body — keep the status line */
    }
    throw new SmsProviderError(msg, "TELNYX");
  }
  const data = (JSON.parse(text) as any)?.data ?? {};
  const cost =
    data.cost && typeof data.cost.amount !== "undefined"
      ? {
          amount: Number(data.cost.amount),
          currency: String(data.cost.currency ?? "USD"),
        }
      : null;
  return { id: data.id, segments: Number(data.parts) || 1, cost };
}

// ── Vonage (pre-existing skeleton, kept so SMS_PROVIDER=VONAGE still works) ─

async function sendViaVonage(args: {
  to: string;
  from: string;
  body: string;
}): Promise<SmsSendResult> {
  const res = await fetch("https://rest.nexmo.com/sms/json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.VONAGE_API_KEY,
      api_secret: process.env.VONAGE_API_SECRET,
      to: args.to,
      from: args.from,
      text: args.body,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new SmsProviderError(`Vonage HTTP ${res.status}`, "VONAGE");
  const json = JSON.parse(text) as {
    messages?: Array<{ status?: string; "message-id"?: string; "error-text"?: string }>;
  };
  const first = json.messages?.[0];
  // Vonage reports failure in a 200 body, so the status field is the check.
  if (first && first.status !== "0") {
    throw new SmsProviderError(
      first["error-text"] ?? `Vonage status ${first.status}`,
      "VONAGE",
    );
  }
  return {
    id: first?.["message-id"],
    segments: json.messages?.length || 1,
    cost: null,
  };
}

// ── Inbound webhooks ───────────────────────────────────────────────────────

/**
 * Normalise an inbound-SMS webhook body to { from, text } across providers.
 * Twilio posts form-encoded From/Body; Telnyx posts JSON with the sender
 * nested at data.payload.from.phone_number.
 */
export function parseInboundSms(body: any): { from: string; text: string } {
  if (!body) return { from: "", text: "" };
  // Telnyx
  const payload = body?.data?.payload;
  if (payload) {
    if (body?.data?.event_type && body.data.event_type !== "message.received") {
      // Delivery receipts arrive on the same URL — not an inbound message.
      return { from: "", text: "" };
    }
    return {
      from: String(payload?.from?.phone_number ?? ""),
      text: String(payload?.text ?? ""),
    };
  }
  // Twilio (and anything else posting flat From/Body)
  return {
    from: String(body.From ?? body.from ?? ""),
    text: String(body.Body ?? body.body ?? ""),
  };
}

/**
 * Verify a Telnyx webhook signature (Ed25519 over "timestamp|rawBody").
 *
 * Only enforced when TELNYX_PUBLIC_KEY is set — an unset key means "not
 * configured yet", and refusing every webhook then would silently break
 * STOP handling, which is worse than the forged-STOP risk it prevents.
 * Set the key (Mission Control → Account → Keys) in production.
 */
export function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string | undefined,
  timestamp: string | undefined,
): boolean {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY?.trim();
  if (!publicKeyB64) return true;
  if (!signatureB64 || !timestamp) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require("crypto") as typeof import("crypto");
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        // DER prefix for a raw Ed25519 public key.
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyB64, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch (err) {
    logger.warn(`Telnyx signature check failed: ${(err as Error).message}`);
    return false;
  }
}
