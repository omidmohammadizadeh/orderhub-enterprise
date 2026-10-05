// Phase AP-AUTH — transactional email via Resend.
//
// One service, one job: deliver short transactional emails (signup
// confirmation, team-member invites, future order receipts). Anything
// marketing-shaped (campaigns, broadcasts) should go through Resend's
// Broadcasts product directly from their dashboard — out of scope here.
//
// Design choices:
//
//   * Lazy `require` of the SDK so dev/CI machines without the package
//     don't crash on boot — they just log "Resend not configured" and
//     pretend to send.
//
//   * Mock-on-missing-key: when RESEND_API_KEY is absent (local dev,
//     unit tests, staging that hasn't been wired yet), every send()
//     resolves successfully and writes the body to the log. Lets
//     downstream code stay simple — no `if (this.email)` guards
//     scattered everywhere.
//
//   * HTML-only bodies for now. Resend strips HTML to plain text for
//     deliverability, so we don't maintain dual versions.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Call Resend's HTTP API directly with fetch instead of pulling in
// the npm SDK. Two reasons:
//   1. Their SDK lists react + react-dom as peer dependencies (for
//      the React-Email helpers we don't use). In a partial monorepo
//      install (which is what Render's Docker build does) that
//      peer-dep tree resolves inconsistently and breaks
//      --frozen-lockfile.
//   2. The Resend API is one endpoint with a JSON body and a Bearer
//      header — fetch is genuinely all we need.
// Node 18+ has a global fetch, so no import is required.

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Resend auto-derives one if omitted. */
  text?: string;
  /** Optional Reply-To. Defaults to the platform support address. */
  replyTo?: string;
  /**
   * Display name to front the email with, e.g. the restaurant's.
   *
   * The ADDRESS is unchanged — it stays the one verified with Resend — and
   * only the human-readable part varies. That matters because a customer
   * ordering from a restaurant expects to hear from the restaurant, and a
   * verified domain per brand (3 on Resend's free plan) will never cover them
   * all.
   */
  fromName?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_BATCH_ENDPOINT = "https://api.resend.com/emails/batch";

/** One email inside a Resend batch call (max 100 per call). */
export interface BatchEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  /** A full `Name <address>` that replaces the platform sender's address —
   *  marketing goes out from its own subdomain. */
  fromAddress?: string;
  headers?: Record<string, string>;
}

/** A Resend refusal, carrying the HTTP status so a caller can tell "slow
 *  down" (429) and "Resend is having a bad minute" (5xx) from a bad request. */
export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | null;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>("RESEND_API_KEY");
    // EMAIL_FROM is the long-standing platform env var (defaults to
    // "OrderHub <noreply@orderhub.io>" in env.validation.ts). For
    // Phase AP-AUTH the operator should set it to their verified
    // Resend sender, e.g. "Order Hub <hello@orderhubsolutions.com>".
    this.fromAddress =
      this.config.get<string>("EMAIL_FROM") ??
      "Order Hub <hello@orderhubsolutions.com>";

    if (apiKey) {
      this.apiKey = apiKey;
      this.logger.log(
        `Resend HTTP client ready (from: ${this.fromAddress})`,
      );
    } else {
      this.apiKey = null;
      this.logger.warn(
        "RESEND_API_KEY not set — emails will be logged, not delivered",
      );
    }
  }

  /**
   * Fire-and-await an email send. Errors are logged and swallowed in
   * mock mode; in real mode the Promise resolves with the Resend ID
   * (or rejects on hard failures — caller decides whether to retry).
   */
  /**
   * `Name <address>` with the name swapped, or the configured value as-is.
   * Quotes and angle brackets are stripped from the name: it is restaurant
   * data and would otherwise be able to rewrite the header.
   */
  private fromWithName(name?: string): string {
    const clean = String(name ?? "").replace(/[<>"\r\n]/g, "").trim();
    if (!clean) return this.fromAddress;
    const match = this.fromAddress.match(/<([^>]+)>/);
    const address = match ? match[1] : this.fromAddress;
    return `${clean} <${address}>`;
  }

  /** True when a real Resend key is configured (false = mock/log mode). */
  isLive(): boolean {
    return !!this.apiKey;
  }

  /**
   * Send up to 100 emails in ONE Resend call. Returns the Resend ids in the
   * same order as `emails`.
   *
   * `idempotencyKey` makes a retry of the same batch safe: if the first call
   * reached Resend but our process died before recording it, the retry is
   * answered from Resend's record instead of mailing everyone twice. The key
   * must only ever be reused for the identical batch.
   */
  async sendBatch(
    emails: BatchEmail[],
    idempotencyKey?: string,
  ): Promise<{ ids: (string | null)[] }> {
    if (emails.length === 0) return { ids: [] };
    if (emails.length > 100) throw new Error("Resend batches hold at most 100 emails");
    if (!this.apiKey) {
      this.logger.log(
        `[mock email batch] ${emails.length} emails, subject="${emails[0]!.subject}"`,
      );
      return { ids: emails.map(() => null) };
    }
    const res = await fetch(RESEND_BATCH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(
        emails.map((e) => ({
          from: e.fromAddress
            ? this.withName(e.fromAddress, e.fromName)
            : this.fromWithName(e.fromName),
          to: [e.to],
          subject: e.subject,
          html: e.html,
          text: e.text,
          reply_to: e.replyTo,
          headers: e.headers,
        })),
      ),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ResendError(`Resend batch ${res.status}: ${body || res.statusText}`, res.status);
    }
    const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    const rows = Array.isArray(data?.data) ? data.data : [];
    return { ids: emails.map((_, i) => rows[i]?.id ?? null) };
  }

  /** `Name <address>` built from a configured sender and a display name. */
  private withName(from: string, name?: string): string {
    const clean = String(name ?? "").replace(/[<>"\r\n]/g, "").trim();
    const match = from.match(/<([^>]+)>/);
    const address = match ? match[1] : from.trim();
    return clean ? `${clean} <${address}>` : from;
  }

  async send(opts: SendEmailOpts): Promise<{ id: string | null }> {
    if (!this.apiKey) {
      // Mock path — log enough to debug a missing email in dev without
      // dumping the entire HTML body in the console.
      this.logger.log(
        `[mock email] to=${opts.to} subject="${opts.subject}" (${opts.html.length} bytes html)`,
      );
      return { id: null };
    }
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromWithName(opts.fromName),
          to: [opts.to],
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
          reply_to: opts.replyTo,
        }),
      });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(
          `Resend ${res.status}: ${errorBody || res.statusText}`,
        );
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      const id = data?.id ?? null;
      this.logger.log(
        `Email sent to ${opts.to} subject="${opts.subject}" id=${id ?? "n/a"}`,
      );
      return { id };
    } catch (err: any) {
      this.logger.error(
        `Email send failed (to=${opts.to} subject="${opts.subject}"): ${err.message}`,
      );
      throw err;
    }
  }
}
