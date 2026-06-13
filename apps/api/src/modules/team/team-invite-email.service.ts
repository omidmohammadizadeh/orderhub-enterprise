// Phase AR — Team invitation email.
//
// Wraps the platform EmailService with the specific subject + body
// for the "you've been invited" message. Kept as its own service so
// the email copy lives next to the invite flow it serves, not
// scattered across the infrastructure layer.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailService } from "../../infrastructure/email/email.service";

export interface SendInviteOpts {
  to: string;
  token: string;
  role: string;
  tenantName: string;
  inviterName: string;
}

@Injectable()
export class TeamInviteEmailService {
  private readonly logger = new Logger(TeamInviteEmailService.name);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async sendInvite(opts: SendInviteOpts): Promise<void> {
    const webOrigin = (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
    const acceptUrl = `${webOrigin}/accept-invite?token=${opts.token}`;
    const friendlyRole = humaniseRole(opts.role);

    const subject = `${opts.inviterName} invited you to ${opts.tenantName} on Order Hub`;
    const html = inviteHtml({ ...opts, friendlyRole, acceptUrl });

    await this.email.send({ to: opts.to, subject, html });
    this.logger.log(
      `Invitation email sent to ${opts.to} (role=${opts.role}, tenant=${opts.tenantName})`,
    );
  }
}

function humaniseRole(role: string): string {
  return role
    .split("_")
    .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
    .join(" ");
}

function inviteHtml(opts: SendInviteOpts & {
  friendlyRole: string;
  acceptUrl: string;
}): string {
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#fafafa; padding:32px; color:#18181b;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="font-size:22px; font-weight:700; margin:0 0 8px;">You're invited to ${escapeHtml(opts.tenantName)}</h1>
      <p style="font-size:15px; color:#52525b; line-height:1.5; margin:0 0 24px;">
        ${escapeHtml(opts.inviterName)} invited you to join <strong>${escapeHtml(opts.tenantName)}</strong> on Order Hub as a <strong>${escapeHtml(opts.friendlyRole)}</strong>.
      </p>
      <p style="font-size:15px; color:#52525b; line-height:1.5; margin:0 0 24px;">
        Click the button below to accept the invitation. You can create a password, or sign in with Google to skip the password step.
      </p>
      <p style="text-align:center; margin:32px 0;">
        <a href="${opts.acceptUrl}" style="display:inline-block; background:#7c3aed; color:#ffffff; padding:12px 28px; border-radius:8px; font-weight:600; text-decoration:none;">Accept invitation</a>
      </p>
      <p style="font-size:13px; color:#71717a; line-height:1.5; margin:0 0 8px;">
        Or copy this link into your browser:<br/>
        <span style="color:#3f3f46; word-break:break-all;">${opts.acceptUrl}</span>
      </p>
      <p style="font-size:12px; color:#a1a1aa; line-height:1.5; margin:24px 0 0;">
        This invitation expires in 14 days. If you weren't expecting this, you can safely ignore the email.
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
