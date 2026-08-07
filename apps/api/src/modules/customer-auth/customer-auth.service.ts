// Phase AP-AUTH — Customer-facing auth for the public storefront.
//
// Separate from staff auth (AuthService) because:
//   1. Different identity model (Customer, not User)
//   2. Different JWT audience so customer tokens can't access /v1/...
//      staff endpoints by accident
//   3. Different signup UX: email confirmation required for password
//      signups; immediate session for Google OAuth (Google verified)
//
// What lives here:
//   * signup()           — create Customer, send confirmation email
//   * verifyEmail()      — flip isVerified, return session JWT
//   * login()            — email/password authentication, return JWT
//   * createOrLinkGoogle()— upsert Customer from Google profile (used by
//                          the OAuth callback handler)
//   * getById()          — load Customer for the JWT strategy

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { PasswordService } from "../auth/services/password.service";
import { CustomerSignupDto } from "./dto/signup.dto";
import { CustomerLoginDto } from "./dto/login.dto";

// Phase AP-5 — fields the customer "My Orders" page needs and nothing
// else. Includes the location's slug + name + Google review URL so
// each order card can link back to the storefront and render the
// "Leave review" CTA without a second round-trip.
const ORDER_PROJECTION = {
  id: true,
  displayId: true,
  orderNumber: true,
  status: true,
  fulfillmentType: true,
  total: true,
  // NOTE: Order has no `currency` column — Payment owns currency. The
  // storefront only handles GBP today so we can hardcode the symbol in
  // the UI; if/when multi-currency lands, surface it from the
  // Payment row instead.
  createdAt: true,
  scheduledFor: true,
  estimatedReadyAt: true,
  deliveredAt: true,
  cancelledAt: true,
  paymentStatus: true,
  paymentMethod: true,
  items: {
    select: {
      id: true,
      name: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      modifiers: true,
      notes: true,
    },
  },
  location: {
    select: {
      id: true,
      name: true,
      onlineOrderingSlug: true,
      googleReviewUrl: true,
      logoUrl: true,
    },
  },
  // Phase AW-30 — surface the brand identity so the customer's My
  // Orders cards show the brand they actually ordered from, not the
  // underlying kitchen location. Falls back to location in the UI for
  // legacy orders predating the brand pinning.
  brand: {
    select: {
      id: true,
      name: true,
      onlineOrderingSlug: true,
      logoUrl: true,
    },
  },
} as const;

function serialiseOrderForCustomer(o: any) {
  // Strip nothing — the projection already selected only safe fields.
  // We do convert Decimal to number so the JSON wire format is plain.
  return {
    ...o,
    total: typeof o.total?.toNumber === "function" ? o.total.toNumber() : o.total,
    items: (o.items ?? []).map((it: any) => ({
      ...it,
      unitPrice:
        typeof it.unitPrice?.toNumber === "function"
          ? it.unitPrice.toNumber()
          : it.unitPrice,
      totalPrice:
        typeof it.totalPrice?.toNumber === "function"
          ? it.totalPrice.toNumber()
          : it.totalPrice,
    })),
  };
}

// JWT audience used to distinguish customer tokens from staff tokens.
// CustomerJwtStrategy verifies this matches before accepting a token,
// so a leaked customer JWT can't be replayed against staff endpoints
// and vice versa.
/** One year, matching the staff refresh window. */
export const CUSTOMER_TOKEN_TTL = "365d";
export const CUSTOMER_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Cookie name for the customer session.
 *
 * The session lives in TWO places, on purpose. localStorage alone is not
 * durable on the browsers takeaway customers actually use: iOS Safari purges
 * script-writable storage after 7 days without a first-party interaction, and
 * an in-app webview — the WhatsApp or Instagram browser a shared ordering link
 * opens in — often never persists it at all. A cookie set by the server
 * survives both, which is the difference between "remembered" and "log in
 * again every time".
 */
export const CUSTOMER_TOKEN_COOKIE = "orderhub_customer";

export const CUSTOMER_JWT_AUDIENCE = "orderhub-customer";

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async signup(dto: CustomerSignupDto): Promise<{ pendingVerification: true; email: string }> {
    const emailNormalised = dto.email.trim().toLowerCase();

    // Strength check happens after the basic DTO validation so we can
    // return the specific rule failure (uppercase missing, etc.) rather
    // than a generic "min length 8".
    const strength = this.password.validateStrength(dto.password);
    if (!strength.valid) {
      throw new BadRequestException(strength.errors.join(". "));
    }

    const existing = await (this.prisma as any).customerAccount.findUnique({
      where: { email: emailNormalised },
    });
    if (existing) {
      // Soft-leak prevention: same message whether the row exists or not.
      // The genuinely-new-user path also lands here when they re-submit
      // a stale signup form, so this isn't user-hostile.
      throw new ConflictException(
        "An account already exists with this email. Try signing in.",
      );
    }

    const hashed = await this.password.hash(dto.password);
    // 32 bytes of randomness, hex-encoded. Single-use; cleared on verify.
    const token = randomBytes(32).toString("hex");

    const customer = await (this.prisma as any).customerAccount.create({
      data: {
        email: emailNormalised,
        password: hashed,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        phone: dto.phone?.trim() || null,
        isVerified: false,
        emailVerificationToken: token,
        marketingOptIn: dto.marketingOptIn ?? false,
      },
    });

    await this.sendConfirmationEmail({
      to: customer.email,
      firstName: customer.firstName,
      token,
      storeSlug: dto.storeSlug,
    });

    this.logger.log(
      `Customer signup: ${customer.id} (${customer.email}) — verification email sent`,
    );

    return { pendingVerification: true, email: customer.email };
  }

  async verifyEmail(token: string): Promise<{ accessToken: string; customer: any }> {
    if (!token || token.length < 32) {
      throw new BadRequestException("Invalid verification link");
    }
    const customer = await (this.prisma as any).customerAccount.findFirst({
      where: { emailVerificationToken: token },
    });
    if (!customer) {
      throw new BadRequestException(
        "This verification link is no longer valid. It may have already been used, or you may have signed up again — try logging in.",
      );
    }
    const updated = await (this.prisma as any).customerAccount.update({
      where: { id: customer.id },
      data: {
        isVerified: true,
        emailVerificationToken: null,
        lastLoginAt: new Date(),
      },
    });
    return {
      accessToken: await this.signCustomerToken(updated),
      customer: this.serialise(updated),
    };
  }

  async login(dto: CustomerLoginDto): Promise<{ accessToken: string; customer: any }> {
    const emailNormalised = dto.email.trim().toLowerCase();
    const customer = await (this.prisma as any).customerAccount.findUnique({
      where: { email: emailNormalised },
    });
    // Deliberately identical 401 for "no such email" and "wrong password"
    // — prevents account enumeration.
    if (!customer || !customer.password) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const ok = await this.password.compare(dto.password, customer.password);
    if (!ok) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (!customer.isVerified) {
      throw new UnauthorizedException(
        "Please confirm your email first. Check your inbox for the confirmation link we sent.",
      );
    }
    await (this.prisma as any).customerAccount.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() },
    });
    return {
      accessToken: await this.signCustomerToken(customer),
      customer: this.serialise(customer),
    };
  }

  /**
   * Used by the Google OAuth callback (next increment). Finds an
   * existing Customer by googleId or email, or creates a new one
   * marked isVerified (Google has already verified the address).
   */
  async createOrLinkGoogle(profile: {
    googleId: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
  }): Promise<{ accessToken: string; customer: any }> {
    const emailNormalised = profile.email.trim().toLowerCase();
    // Existing Google-linked account → just sign in.
    let customer = await (this.prisma as any).customerAccount.findUnique({
      where: { googleId: profile.googleId },
    });
    if (!customer) {
      // Maybe they signed up by email previously and are now linking
      // Google — match on email.
      customer = await (this.prisma as any).customerAccount.findUnique({
        where: { email: emailNormalised },
      });
      if (customer) {
        customer = await (this.prisma as any).customerAccount.update({
          where: { id: customer.id },
          data: {
            googleId: profile.googleId,
            isVerified: true,
            avatarUrl: customer.avatarUrl ?? profile.avatarUrl ?? null,
            lastLoginAt: new Date(),
          },
        });
      } else {
        // Brand new customer.
        customer = await (this.prisma as any).customerAccount.create({
          data: {
            email: emailNormalised,
            googleId: profile.googleId,
            firstName: profile.firstName,
            lastName: profile.lastName,
            avatarUrl: profile.avatarUrl ?? null,
            isVerified: true,
            lastLoginAt: new Date(),
            // No password — Google-only account. Can set one later
            // via password-reset if they want email login too.
          },
        });
      }
    } else {
      // Existing Google-linked customer — just bump lastLoginAt.
      customer = await (this.prisma as any).customerAccount.update({
        where: { id: customer.id },
        data: { lastLoginAt: new Date() },
      });
    }
    return {
      accessToken: await this.signCustomerToken(customer),
      customer: this.serialise(customer),
    };
  }

  async getById(id: string): Promise<any | null> {
    const customer = await (this.prisma as any).customerAccount.findUnique({
      where: { id },
    });
    return customer ? this.serialise(customer) : null;
  }

  /**
   * Phase AP-5 — list a customer's orders, split into "active" (in
   * flight) and "history" (terminal). Pulled together here rather
   * than via the OrdersService because the public storefront cannot
   * be authenticated as a staff user, and we want minimal projection
   * (no tenant-internal fields like outbox event ids) over the wire.
   *
   * History is capped at 50 most recent — anything older is rare
   * enough on the storefront that a "load more" pager would be wasted
   * effort. Active is uncapped because the realistic max is single
   * digits anyway.
   */
  async listOrders(
    customerAccountId: string,
    opts: { brandId?: string; storeSlug?: string } = {},
  ): Promise<{
    active: any[];
    history: any[];
  }> {
    const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"];
    const { brandId, storeSlug } = opts;

    // Storefront scoping. We host storefronts for many independent
    // shops against one shared customer account, so a customer on shop
    // A's URL (or custom domain) must never see their history from
    // shop B.
    //
    // • storeSlug — the /order/<slug> the customer is on — resolves to
    //   a location (same OR-resolution as getStorefrontBySlug) and
    //   scopes to that location's orders. An unresolvable slug fails
    //   CLOSED with empty lists, never tenant-wide.
    // • brandId (?brand=<id>, Phase AW brand overlay) additionally
    //   narrows to that brand for multi-brand kitchens.
    // • Neither param → legacy unscoped behaviour, kept only so old
    //   cached clients don't break; the web app always sends storeSlug.
    const brandFilter = brandId ? { brandId } : {};
    let locationFilter: { locationId?: string } = {};
    if (storeSlug) {
      const location = await this.prisma.location.findFirst({
        where: {
          OR: [
            { onlineOrderingSlug: storeSlug },
            { slug: storeSlug },
            { id: storeSlug },
          ],
        },
        select: { id: true },
      });
      if (!location) return { active: [], history: [] };
      locationFilter = { locationId: location.id };
    }

    // One query for each side. The board uses a single live query
    // for staff; the customer page is loaded on demand and benefits
    // from precise filtering at the DB layer.
    const [active, history] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          customerAccountId,
          status: { notIn: TERMINAL_STATUSES as any },
          ...brandFilter,
          ...locationFilter,
        },
        select: ORDER_PROJECTION,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.order.findMany({
        where: {
          customerAccountId,
          status: { in: TERMINAL_STATUSES as any },
          ...brandFilter,
          ...locationFilter,
        },
        select: ORDER_PROJECTION,
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    return {
      active: active.map(serialiseOrderForCustomer),
      history: history.map(serialiseOrderForCustomer),
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  async signCustomerToken(customer: any): Promise<string> {
    // We pass `audience` via the OPTIONS object, not as `aud` in the
    // payload — the shared JwtModule (auth.module.ts) sets a default
    // audience of "orderhub-api" in signOptions. If we also put `aud`
    // into the payload, jsonwebtoken refuses both with:
    //   "Bad options.audience option. The payload already has an aud property."
    // Overriding via the options object lets us swap the audience to
    // CUSTOMER_JWT_AUDIENCE without touching the staff token flow.
    return this.jwt.signAsync(
      {
        sub: customer.id,
        email: customer.email,
      },
      {
        audience: CUSTOMER_JWT_AUDIENCE,
        // A year, and SLIDING — /me re-signs on every call, so an actively
        // returning customer is never logged out. Matches the staff session
        // length; there is no reason a takeaway customer should be asked to
        // sign in more often than the staff who serve them.
        expiresIn: CUSTOMER_TOKEN_TTL,
      },
    );
  }

  private serialise(customer: any) {
    return {
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      avatarUrl: customer.avatarUrl,
      isVerified: customer.isVerified,
    };
  }

  private async sendConfirmationEmail(opts: {
    to: string;
    firstName: string;
    token: string;
    storeSlug?: string;
  }) {
    const webUrl =
      this.config.get<string>("WEB_URL") ??
      "https://www.orderhubsolutions.com";
    // Link lands on the storefront's confirm page so the customer ends
    // up back at the menu they were trying to order from. Without
    // storeSlug, fall back to the marketing homepage.
    const confirmPath = opts.storeSlug
      ? `/order/${encodeURIComponent(opts.storeSlug)}/auth/confirm?token=${opts.token}`
      : `/auth/confirm?token=${opts.token}`;
    const url = `${webUrl}${confirmPath}`;

    const html = `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f8fafc; padding: 32px 16px; margin: 0;">
  <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <tr><td>
      <h1 style="margin: 0 0 16px; font-size: 20px; color: #0f172a;">Welcome, ${escapeHtml(opts.firstName)}</h1>
      <p style="margin: 0 0 20px; font-size: 14px; color: #475569; line-height: 1.5;">
        Tap the button below to confirm your email and start ordering.
      </p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background: #059669; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">Confirm my email</a>
      </p>
      <p style="margin: 24px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
        Or copy this link into your browser:<br>
        <span style="color: #64748b; word-break: break-all;">${url}</span>
      </p>
      <p style="margin: 24px 0 0; font-size: 11px; color: #94a3b8;">
        If you didn't create an Order Hub account, you can ignore this email.
      </p>
    </td></tr>
  </table>
</body></html>`;

    try {
      await this.email.send({
        to: opts.to,
        subject: "Confirm your Order Hub account",
        html,
      });
    } catch (err: any) {
      // Don't fail the signup if email send fails — the row is in DB
      // and the operator can re-trigger via a "resend confirmation"
      // flow (not built yet). Log loudly.
      this.logger.error(
        `Confirmation email failed for ${opts.to}: ${err.message}`,
      );
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
