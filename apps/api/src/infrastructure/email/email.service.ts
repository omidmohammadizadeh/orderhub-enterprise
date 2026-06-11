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

let Resend: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Resend = require("resend").Resend;
} catch {
  /* package not installed in this environment — fall through to mock */
}

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Resend auto-derives one if omitted. */
  text?: string;
  /** Optional Reply-To. Defaults to the platform support address. */
  replyTo?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: any | null;
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

    if (apiKey && Resend) {
      this.client = new Resend(apiKey);
      this.logger.log(
        `Resend client initialised (from: ${this.fromAddress})`,
      );
    } else {
      this.client = null;
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
    if (!this.client) {
      // Mock path — log enough to debug a missing email in dev without
      // dumping the entire HTML body in the console.
      this.logger.log(
        `[mock email] to=${opts.to} subject="${opts.subject}" (${opts.html.length} bytes html)`,
      );
      return { id: null };
    }
    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        reply_to: opts.replyTo,
      });
      const id = result?.data?.id ?? null;
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
