// Phase AW-30 follow-up — payment-failure notifications.
//
// Before this, invoice.payment_failed only wrote lastFailureMessage onto
// the MerchantSubscription row — silently, with nothing surfacing it
// anywhere. A merchant's subscription payment could fail and sit
// unnoticed until someone happened to open that location's row on the
// Subscription page (that's exactly what happened to Castle Grill).
//
// Wraps the platform EmailService with the copy for both audiences: the
// client, who needs to know their card was declined and how to fix it,
// and us, who need to know a merchant is at risk of losing service.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailService } from "../../infrastructure/email/email.service";

export interface PaymentFailedOpts {
  locationName: string;
  amountDue: number; // pence
  currency: string;
  failureMessage: string | null;
  clientEmail: string | null;
  manageUrl: string;
}

@Injectable()
export class SubscriptionAlertEmailService {
  private readonly logger = new Logger(SubscriptionAlertEmailService.name);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async notifyPaymentFailed(opts: PaymentFailedOpts): Promise<void> {
    const amount = `${opts.currency === "gbp" ? "£" : opts.currency.toUpperCase() + " "}${(opts.amountDue / 100).toFixed(2)}`;

    if (opts.clientEmail) {
      await this.email
        .send({
          to: opts.clientEmail,
          subject: `Payment failed for your Order Hub subscription — ${opts.locationName}`,
          html: clientHtml({ ...opts, amount }),
        })
        .catch((err) =>
          this.logger.warn(
            `Client payment-failed email not sent (${opts.locationName}): ${err.message}`,
          ),
        );
    } else {
      this.logger.warn(
        `No client email on file for ${opts.locationName} — skipped their payment-failed notice`,
      );
    }

    const opsEmail = this.config.get<string>("BILLING_ALERT_EMAIL");
    if (opsEmail) {
      await this.email
        .send({
          to: opsEmail,
          subject: `[Billing] Payment failed — ${opts.locationName}`,
          html: opsHtml({ ...opts, amount }),
        })
        .catch((err) =>
          this.logger.warn(
            `Ops payment-failed email not sent (${opts.locationName}): ${err.message}`,
          ),
        );
    } else {
      this.logger.warn(
        "BILLING_ALERT_EMAIL not set — payment-failed alert only went to the client (if we had their email)",
      );
    }
  }
}

function clientHtml(opts: {
  locationName: string;
  amount: string;
  failureMessage: string | null;
  manageUrl: string;
}): string {
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#fafafa; padding:32px; color:#18181b;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="font-size:22px; font-weight:700; margin:0 0 8px;">We couldn't take payment for ${escapeHtml(opts.locationName)}</h1>
      <p style="font-size:15px; color:#52525b; line-height:1.5; margin:0 0 16px;">
        Your Order Hub subscription payment of <strong>${escapeHtml(opts.amount)}</strong> didn't go through${
          opts.failureMessage ? ` — <em>${escapeHtml(opts.failureMessage)}</em>` : ""
        }.
      </p>
      <p style="font-size:15px; color:#52525b; line-height:1.5; margin:0 0 24px;">
        Nothing has been switched off yet, but please update your card or retry payment as soon as you can to keep your account in good standing.
      </p>
      <p style="text-align:center; margin:32px 0;">
        <a href="${opts.manageUrl}" style="display:inline-block; background:#7c3aed; color:#ffffff; padding:12px 28px; border-radius:8px; font-weight:600; text-decoration:none;">Update payment details</a>
      </p>
    </div>
  </body>
</html>`;
}

function opsHtml(opts: {
  locationName: string;
  amount: string;
  failureMessage: string | null;
  manageUrl: string;
}): string {
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#fafafa; padding:32px; color:#18181b;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="font-size:20px; font-weight:700; margin:0 0 8px;">Payment failed — ${escapeHtml(opts.locationName)}</h1>
      <p style="font-size:14px; color:#52525b; line-height:1.5; margin:0 0 8px;">
        Amount: <strong>${escapeHtml(opts.amount)}</strong>
      </p>
      ${opts.failureMessage ? `<p style="font-size:14px; color:#52525b; line-height:1.5; margin:0 0 16px;">Reason: ${escapeHtml(opts.failureMessage)}</p>` : ""}
      <p style="font-size:14px; color:#52525b; line-height:1.5; margin:0 0 16px;">
        The client has also been emailed (if we have their address on file). Check the Subscription page if you want to follow up directly.
      </p>
      <p style="text-align:center; margin:24px 0;">
        <a href="${opts.manageUrl}" style="display:inline-block; background:#18181b; color:#ffffff; padding:10px 22px; border-radius:8px; font-weight:600; text-decoration:none; font-size:14px;">Open subscription</a>
      </p>
    </div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
