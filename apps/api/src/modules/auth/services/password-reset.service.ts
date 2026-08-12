import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { EmailService } from "../../../infrastructure/email/email.service";
import { PasswordService } from "./password.service";

/**
 * "I've forgotten my password."
 *
 * A reset link is a temporary key to someone's account, so this is written
 * defensively throughout:
 *
 *  - **We never say whether an address is registered.** Both the found and
 *    not-found paths return the same message after the same work. Otherwise
 *    this endpoint becomes a way to test which of a list of emails have
 *    OrderHub accounts.
 *  - **Only the hash of the token is stored.** Our database is the likeliest
 *    thing to leak; a table of live reset tokens would be a table of accounts.
 *  - **One use, one hour.** Reset emails linger in mailboxes and get forwarded
 *    to whoever is helping. Spent links must be dead.
 *  - **Resetting ends every session.** People reset passwords precisely when
 *    they think someone else is in their account, and a new password that
 *    leaves the intruder logged in would be worse than useless.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  /** Long enough that guessing is hopeless, short enough to sit in a URL. */
  private static readonly TOKEN_BYTES = 32;
  private static readonly TTL_MINUTES = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService,
  ) {}

  private hash(token: string) {
    // SHA-256, not bcrypt: this is a 256-bit random value, not a human
    // password, so there is nothing to brute-force and we need the lookup to
    // be a plain indexed equality check.
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private webBase() {
    return (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
  }

  /**
   * Send a reset link, if that address belongs to an account.
   *
   * Always resolves the same way. The caller must not be able to tell the
   * difference between a hit and a miss — not from the message, not from a
   * status code.
   */
  async request(
    email: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<void> {
    const normalised = String(email ?? "").trim().toLowerCase();
    if (!normalised.includes("@")) return;

    const user = await this.prisma.user.findUnique({
      where: { email: normalised },
      select: { id: true, email: true, firstName: true, isActive: true },
    });

    if (!user || !user.isActive) {
      // Deliberately silent to the caller. Logged so a real person locked out
      // by a deactivated account can be helped when they ring up.
      this.logger.log(
        `Password reset requested for ${normalised} — no active account, no email sent`,
      );
      return;
    }

    // Any earlier link becomes void. If someone clicks through several
    // requests, only the newest should work; leaving the older ones live
    // widens the window for no benefit.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto
      .randomBytes(PasswordResetService.TOKEN_BYTES)
      .toString("base64url");

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(token),
        expiresAt: new Date(
          Date.now() + PasswordResetService.TTL_MINUTES * 60_000,
        ),
        requestedIp: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    const link = `${this.webBase()}/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await this.email.send({
        to: user.email,
        subject: "Reset your Order Hub password",
        html: this.emailHtml(user.firstName, link),
        text: this.emailText(user.firstName, link),
      });
      this.logger.log(`Password reset link sent to user ${user.id}`);
    } catch (e: any) {
      // Don't surface this either — a send failure that only happens for real
      // addresses is itself an account oracle. It's in the logs, and the user
      // can request another.
      this.logger.error(
        `Password reset email failed for user ${user.id}: ${e?.message}`,
      );
    }
  }

  /** Is this link still good? Lets the page say so before asking for a password. */
  async check(token: string): Promise<{ valid: boolean }> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hash(String(token ?? "")) },
      select: { usedAt: true, expiresAt: true },
    });
    return {
      valid: !!row && !row.usedAt && row.expiresAt > new Date(),
    };
  }

  /**
   * Spend the link and set the new password.
   *
   * Marking the token used and writing the password happen in one transaction
   * so a crash between them can't leave a live link on a changed password.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException(
        "Choose a password of at least 8 characters.",
      );
    }

    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hash(String(token ?? "")) },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });

    // One message for missing, spent and expired alike. Distinguishing them
    // tells someone holding a stolen link which kind of wrong it is.
    if (!row || row.usedAt || row.expiresAt <= new Date()) {
      throw new BadRequestException(
        "That reset link is no longer valid. Please request a new one.",
      );
    }

    const hash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { password: hash },
      }),
      // Everything else this account had open is now signed out. Someone
      // resetting because they think they've been compromised gets exactly
      // what they came for.
      this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.logger.log(
      `Password reset completed for user ${row.userId} — all sessions revoked`,
    );
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  private emailHtml(firstName: string | null, link: string) {
    const hi = firstName ? `Hi ${esc(firstName)},` : "Hi,";
    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px">Reset your password</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6">${hi}</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6">
      We received a request to reset the password on your Order Hub account.
      Click the button below to choose a new one. This link works once and
      expires in ${PasswordResetService.TTL_MINUTES} minutes.
    </p>
    <p style="margin:0 0 24px">
      <a href="${link}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">Reset password</a>
    </p>
    <p style="margin:0 0 8px;font-size:12px;color:#71717a">
      If the button doesn't work, paste this into your browser:
    </p>
    <p style="margin:0 0 24px;font-size:12px;color:#71717a;word-break:break-all">${link}</p>
    <p style="margin:0;font-size:12px;color:#71717a;line-height:1.6">
      If you didn't ask for this, you can ignore this email — your password
      hasn't changed and no one can use this link without your mailbox.
    </p>
  </div>
</body></html>`;
  }

  private emailText(firstName: string | null, link: string) {
    return [
      firstName ? `Hi ${firstName},` : "Hi,",
      "",
      "We received a request to reset the password on your Order Hub account.",
      `Open this link to choose a new one. It works once and expires in ${PasswordResetService.TTL_MINUTES} minutes:`,
      "",
      link,
      "",
      "If you didn't ask for this, you can ignore this email — your password hasn't changed.",
    ].join("\n");
  }
}

/** Minimal HTML escape — a first name goes into the message body. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
