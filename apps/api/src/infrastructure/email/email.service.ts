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
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

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
          from: this.fromAddress,
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
