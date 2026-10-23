import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { currencyForCountry, roundToCurrency, usesTap } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";
import { PaymentsService } from "../payments.service";
import { publicApiBase } from "../../../common/public-api-url";
import {
  MOLLIE_AUTHORIZE_URL,
  MOLLIE_SCOPES,
  MollieApiClient,
  MollieOnboarding,
  MolliePayment,
  mollieAmount,
  signOAuthState,
  verifyOAuthState,
} from "./mollie-api.client";

/**
 * Mollie, as a second UK online-payment provider next to Stripe.
 *
 * ── Where it sits ───────────────────────────────────────────────────────────
 * The country still picks the provider FAMILY (payment-providers.ts: Gulf →
 * Tap, everywhere else → Stripe). Mollie is an opt-in inside the Stripe side,
 * per BRAND: a brand with an enabled MollieConnection takes its storefront
 * card payments and its POS payment links through Mollie; every other brand
 * is untouched and stays on Stripe. Switching a brand back is one toggle —
 * nothing about its Stripe account is changed by connecting Mollie.
 *
 * Once a payment exists, the PAYMENT ROW decides who handles it (reconcile,
 * webhook, refund), never the current toggle: a brand switched back to Stripe
 * still has Mollie payments that need refunding through Mollie.
 *
 * ── The money model (Mollie Connect, Platform model) ────────────────────────
 *   • Each restaurant has its own Mollie organisation, connected to our OAuth
 *     app. Payments are created WITH THEIR TOKEN on their website profile, so
 *     the money settles to their bank on their payout schedule.
 *   • Our cut rides on each payment as `applicationFee`, which Mollie moves
 *     from their balance to ours when the payment is paid. Application fees
 *     are non-refundable: a refund comes out of the restaurant's balance and
 *     our fee stays ours — the same outcome as a Stripe direct-charge refund.
 *   • Same fee config as Stripe/Tap (brand wins over location): the FIXED part
 *     is a visible surcharge added to the customer's total, the PERCENTAGE
 *     part is taken silently from the restaurant's share.
 *
 * ── Onboarding a restaurant ─────────────────────────────────────────────────
 *   1. Already has Mollie → "Connect" sends them to Mollie's consent screen.
 *   2. Has nothing → we create a CLIENT LINK with our platform's own token
 *      (an advanced access token with `clients.write`), pre-filled with their
 *      business details. They open it, Mollie creates their organisation,
 *      they finish KYC on Mollie's pages, and they land back on our OAuth
 *      callback exactly like route 1.
 *   Either way the callback stores their tokens, finds their website profile
 *   and reads their onboarding status.
 *
 * ── Test mode ───────────────────────────────────────────────────────────────
 * OAuth tokens are not test/live keys — every call says which with
 * `testmode`. MOLLIE_TESTMODE (default true) decides, so nothing goes live
 * until it is set to "false" on purpose.
 */
/** What online ordering offers on Mollie's checkout. Google Pay is part of
 *  "creditcard" (Mollie: "Set the method to creditcard" for Google Pay). */
export const STOREFRONT_METHODS = ["creditcard", "applepay"] as const;

@Injectable()
export class MollieService {
  private readonly logger = new Logger(MollieService.name);
  private readonly api = new MollieApiClient(process.env.MOLLIE_API_BASE?.trim() || undefined);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialEncryptionService,
    // Only for confirmPaymentRow: the ledger, the PAID flip, the board and
    // auto-accept are provider-agnostic and must not be reimplemented here.
    private readonly payments: PaymentsService,
  ) {}

  // ── Configuration ──────────────────────────────────────────────────────────

  private get clientId(): string | null {
    return process.env.MOLLIE_CLIENT_ID?.trim() || null;
  }
  private get clientSecret(): string | null {
    return process.env.MOLLIE_CLIENT_SECRET?.trim() || null;
  }
  /** Our own organisation's advanced access token — only for client links. */
  private get platformToken(): string | null {
    return process.env.MOLLIE_PLATFORM_ACCESS_TOKEN?.trim() || null;
  }

  testmode(): boolean {
    return (process.env.MOLLIE_TESTMODE ?? "true").trim().toLowerCase() !== "false";
  }

  /** The OAuth app is registered; restaurants can connect. */
  configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  redirectUri(): string {
    const explicit = process.env.MOLLIE_REDIRECT_URI?.trim();
    if (explicit) return explicit;
    return `${apiBase()}/v1/payments/mollie/oauth/callback`;
  }

  webhookUrl(): string {
    return `${apiBase()}/v1/payments/mollie/webhook`;
  }

  private webUrl(): string {
    return (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
  }

  private requireApp(): { clientId: string; clientSecret: string } {
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        "Mollie isn't set up on the platform yet — MOLLIE_CLIENT_ID and MOLLIE_CLIENT_SECRET are missing.",
      );
    }
    return { clientId, clientSecret };
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────

  private async brandOrThrow(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  private authorizeParams(clientId: string, state: string): URLSearchParams {
    return new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      state,
      scope: MOLLIE_SCOPES.join(" "),
      response_type: "code",
      // Always show the consent screen: a restaurant connecting a second
      // brand must get to choose which organisation it connects, not be
      // silently handed the one it approved last time.
      approval_prompt: "force",
    });
  }

  /** Route 1 — the restaurant already has a Mollie account. */
  async connectUrl(tenantId: string, brandId: string): Promise<{ url: string }> {
    const { clientId, clientSecret } = this.requireApp();
    await this.brandOrThrow(tenantId, brandId);
    const state = signOAuthState({ tenantId, brandId }, clientSecret);
    return { url: `${MOLLIE_AUTHORIZE_URL}?${this.authorizeParams(clientId, state)}` };
  }

  /**
   * Route 2 — onboard a restaurant that has no Mollie account, via the Client
   * Links API. Returns the link to send them; it is valid for 30 days.
   */
  async createClientLink(
    tenantId: string,
    brandId: string,
    input: {
      email: string;
      givenName: string;
      familyName: string;
      organizationName?: string;
      streetAndNumber?: string;
      postalCode?: string;
      city?: string;
      country?: string;
      registrationNumber?: string;
      vatNumber?: string;
    },
  ): Promise<{ url: string; clientLinkId: string }> {
    const { clientId, clientSecret } = this.requireApp();
    const platformToken = this.platformToken;
    if (!platformToken) {
      throw new BadRequestException(
        "Mollie onboarding links need MOLLIE_PLATFORM_ACCESS_TOKEN (an advanced access token with the clients.write permission).",
      );
    }
    if (!input?.email?.trim() || !input?.givenName?.trim() || !input?.familyName?.trim()) {
      throw new BadRequestException("The owner's email, first name and last name are required.");
    }
    const brand = await this.brandOrThrow(tenantId, brandId);

    const country = (input.country?.trim() || "GB").toUpperCase();
    const street = input.streetAndNumber?.trim();
    const link = await this.api.request<{ id: string; _links: { clientLink: { href: string } } }>(
      platformToken,
      "POST",
      "/v2/client-links",
      {
        body: {
          owner: {
            email: input.email.trim(),
            givenName: input.givenName.trim(),
            familyName: input.familyName.trim(),
            locale: "en_GB",
          },
          name: input.organizationName?.trim() || brand.name,
          address: {
            country,
            ...(street ? { streetAndNumber: street } : {}),
            ...(street && input.postalCode?.trim() ? { postalCode: input.postalCode.trim() } : {}),
            ...(street && input.city?.trim() ? { city: input.city.trim() } : {}),
          },
          ...(input.registrationNumber?.trim()
            ? { registrationNumber: input.registrationNumber.trim() }
            : {}),
          ...(input.vatNumber?.trim() ? { vatNumber: input.vatNumber.trim() } : {}),
        },
      },
    );

    const state = signOAuthState({ tenantId, brandId }, clientSecret);
    const url = `${link._links.clientLink.href}?${this.authorizeParams(clientId, state)}`;
    await (this.prisma as any).mollieConnection.upsert({
      where: { brandId },
      create: {
        tenantId,
        brandId,
        status: "link_sent",
        clientLinkId: link.id,
        clientLinkUrl: url,
      },
      update: {
        clientLinkId: link.id,
        clientLinkUrl: url,
        // Don't knock a connected brand back to "link sent" — re-sending a
        // link to an already-connected restaurant changes nothing until they
        // use it.
        ...(await this.isConnected(brandId) ? {} : { status: "link_sent" }),
        lastError: null,
      },
    });
    this.logger.log(`Mollie client link ${link.id} created for brand ${brandId}`);
    return { url, clientLinkId: link.id };
  }

  private async isConnected(brandId: string): Promise<boolean> {
    const c = await (this.prisma as any).mollieConnection.findUnique({ where: { brandId } });
    return !!c?.refreshTokenEnc;
  }

  /**
   * The OAuth redirect, for both routes. Returns where to send the browser:
   * back to the Payments page with the outcome in the query string.
   */
  async handleOAuthCallback(q: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.webUrl()}/dashboard/payments?${new URLSearchParams(params)}`;
    const app = this.configured() ? this.requireApp() : null;
    if (!app) return back({ mollie: "error", reason: "not_configured" });

    const who = verifyOAuthState(q.state, app.clientSecret);
    if (!who) {
      this.logger.warn("Mollie OAuth callback with a bad or expired state — ignored");
      return back({ mollie: "error", reason: "bad_state" });
    }
    if (q.error || !q.code) {
      this.logger.warn(`Mollie OAuth declined for brand ${who.brandId}: ${q.error} ${q.error_description ?? ""}`);
      return back({ mollie: "error", reason: q.error ?? "no_code", brand: who.brandId });
    }

    try {
      // The code is only valid for 30 seconds — exchange it before anything else.
      const tokens = await this.api.tokens(app.clientId, app.clientSecret, {
        grant_type: "authorization_code",
        code: q.code,
        redirect_uri: this.redirectUri(),
      });
      await (this.prisma as any).mollieConnection.upsert({
        where: { brandId: who.brandId },
        create: {
          tenantId: who.tenantId,
          brandId: who.brandId,
          ...this.tokenFields(tokens),
          status: "connected",
          connectedAt: new Date(),
        },
        update: {
          ...this.tokenFields(tokens),
          status: "connected",
          connectedAt: new Date(),
          lastError: null,
        },
      });
      await this.refreshStatus(who.tenantId, who.brandId);
      return back({ mollie: "connected", brand: who.brandId });
    } catch (err: any) {
      this.logger.error(`Mollie OAuth exchange failed for brand ${who.brandId}: ${err?.message}`);
      return back({ mollie: "error", reason: "exchange_failed", brand: who.brandId });
    }
  }

  private tokenFields(tokens: { access_token: string; refresh_token?: string; expires_in: number; scope?: string }) {
    return {
      accessTokenEnc: this.crypto.encrypt({ token: tokens.access_token }),
      ...(tokens.refresh_token
        ? { refreshTokenEnc: this.crypto.encrypt({ token: tokens.refresh_token }) }
        : {}),
      accessTokenExpiresAt: new Date(Date.now() + Math.max(0, tokens.expires_in - 60) * 1000),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
  }

  /**
   * A live access token for a connected brand. Access tokens last an hour;
   * the refresh token is long-lived, so an expired one is renewed here rather
   * than failing the customer's payment.
   */
  private async accessToken(conn: any): Promise<string> {
    if (!conn?.refreshTokenEnc) {
      throw new BadRequestException("This brand's Mollie account isn't connected.");
    }
    const fresh =
      conn.accessTokenEnc &&
      conn.accessTokenExpiresAt &&
      new Date(conn.accessTokenExpiresAt).getTime() > Date.now();
    if (fresh) {
      return (this.crypto.decrypt(conn.accessTokenEnc) as { token: string }).token;
    }
    const { clientId, clientSecret } = this.requireApp();
    const refresh = (this.crypto.decrypt(conn.refreshTokenEnc) as { token: string }).token;
    try {
      const tokens = await this.api.tokens(clientId, clientSecret, {
        grant_type: "refresh_token",
        refresh_token: refresh,
      });
      await (this.prisma as any).mollieConnection.update({
        where: { id: conn.id },
        data: this.tokenFields(tokens),
      });
      return tokens.access_token;
    } catch (err) {
      // A refresh that fails means the restaurant revoked us in Mollie. Say
      // so on the dashboard and stop routing their payments here, so their
      // customers fall back to Stripe instead of a dead checkout.
      await (this.prisma as any).mollieConnection.update({
        where: { id: conn.id },
        data: { status: "revoked", enabled: false, lastError: "Mollie access was revoked — reconnect." },
      });
      throw err;
    }
  }

  /**
   * Re-read a connected brand's organisation, website profile and onboarding
   * state from Mollie. Called after connecting and from the Refresh button.
   */
  async refreshStatus(tenantId: string, brandId: string) {
    const conn = await (this.prisma as any).mollieConnection.findFirst({
      where: { brandId, tenantId },
    });
    if (!conn) throw new NotFoundException("This brand hasn't started Mollie onboarding.");
    if (!conn.refreshTokenEnc) return this.view(conn);

    const token = await this.accessToken(conn);
    const testmode = this.testmode() ? "true" : undefined;
    const [org, onboarding, profiles] = await Promise.all([
      this.api.request<{ id: string; name: string }>(token, "GET", "/v2/organizations/me"),
      this.api.request<MollieOnboarding>(token, "GET", "/v2/onboarding/me"),
      this.api.request<{ _embedded?: { profiles?: Array<{ id: string; status?: string; mode?: string }> } }>(
        token,
        "GET",
        "/v2/profiles",
        { query: { limit: "50", testmode } },
      ),
    ]);
    const list = profiles?._embedded?.profiles ?? [];
    // Keep the profile we already charge on if it still exists; otherwise the
    // first verified one, otherwise the first at all.
    const profileId =
      list.find((p) => p.id === conn.profileId)?.id ??
      list.find((p) => p.status === "verified")?.id ??
      list[0]?.id ??
      null;

    const updated = await (this.prisma as any).mollieConnection.update({
      where: { id: conn.id },
      data: {
        organizationId: org.id,
        organizationName: org.name,
        profileId,
        status: onboarding.status,
        canReceivePayments: !!onboarding.canReceivePayments,
        canReceiveSettlements: !!onboarding.canReceiveSettlements,
        onboardingDashboardUrl: onboarding._links?.dashboard?.href ?? null,
        lastError: profileId
          ? null
          : "No website profile on this Mollie account yet — the restaurant needs to finish onboarding in Mollie.",
        ...(profileId ? { methodStatuses: await this.ensureMethods(token, profileId) } : {}),
      },
    });
    return this.view(updated);
  }

  /**
   * Ask Mollie to switch on the methods our checkout offers, on the
   * restaurant's own profile, so the owner doesn't have to find them in their
   * dashboard. Card first: Apple Pay is refused (422) until card is on, and
   * the next Refresh asks again. Enabling an already-enabled method is a
   * no-op, so this is safe on every refresh.
   *
   * Google Pay can't be switched on this way — Mollie's Enable method API has
   * no id for it. The owner presses + on it in their Mollie dashboard once
   * card is approved; it then shows inside "creditcard" on our checkout.
   *
   * Never throws: a method Mollie won't enable yet must not stop the status
   * refresh that called it.
   */
  private async ensureMethods(token: string, profileId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const method of STOREFRONT_METHODS) {
      try {
        const m = await this.api.request<{ status?: string | null }>(
          token,
          "POST",
          `/v2/profiles/${encodeURIComponent(profileId)}/methods/${method}`,
        );
        out[method] = m?.status ?? "activated";
      } catch (err: any) {
        out[method] = "not-yet";
        this.logger.warn(`Mollie: couldn't enable ${method} on ${profileId}: ${err?.message}`);
      }
    }
    return out;
  }

  // ── Test payment (no order, no switch) ─────────────────────────────────────

  private async connectedOrThrow(tenantId: string, brandId: string) {
    const conn = await (this.prisma as any).mollieConnection.findFirst({
      where: { brandId, tenantId },
    });
    if (!conn?.refreshTokenEnc) throw new BadRequestException("Connect this brand's Mollie account first.");
    if (!conn.profileId) {
      throw new BadRequestException("This Mollie account has no website profile yet — press Refresh once it has.");
    }
    return conn;
  }

  /**
   * A £1.00 TEST-mode payment on the brand's own Mollie account, with no order
   * and without switching the brand to Mollie — so a shop that is trading can
   * be checked without its customers or its kitchen seeing anything.
   *
   * It exercises what a real one does: the restaurant's token and profile, the
   * card/Apple Pay-only checkout, and a 10p application fee (which is how we
   * find out whether Mollie takes our fee in GBP). Always testmode, whatever
   * MOLLIE_TESTMODE says, so it can never move real money.
   */
  async createTestPayment(tenantId: string, brandId: string): Promise<{ paymentId: string; checkoutUrl: string }> {
    const conn = await this.connectedOrThrow(tenantId, brandId);
    const token = await this.accessToken(conn);
    const back = `${this.webUrl()}/dashboard/payments?${new URLSearchParams({ mollieTest: "1", brand: brandId })}`;
    const p = await this.api.request<MolliePayment>(token, "POST", "/v2/payments", {
      body: {
        amount: mollieAmount(1, "GBP"),
        description: "OrderHub test payment",
        redirectUrl: back,
        webhookUrl: this.webhookUrl(),
        locale: "en_GB",
        method: STOREFRONT_METHODS,
        profileId: conn.profileId,
        testmode: true,
        applicationFee: { amount: mollieAmount(0.1, "GBP"), description: "OrderHub test fee" },
        metadata: { orderhubTest: true, brandId },
      },
    });
    const checkoutUrl = p._links?.checkout?.href;
    if (!checkoutUrl) throw new BadRequestException("Mollie didn't return a checkout page for the test payment.");
    await (this.prisma as any).mollieConnection.update({
      where: { id: conn.id },
      data: { lastTestPaymentId: p.id },
    });
    this.logger.log(`Mollie test payment ${p.id} created for brand ${brandId}`);
    return { paymentId: p.id, checkoutUrl };
  }

  /**
   * Where the brand's last test payment got to — and, with refund=true, give
   * it back once paid. Read with the restaurant's token, like the webhook.
   */
  async testPaymentStatus(tenantId: string, brandId: string, refund = false) {
    const conn = await this.connectedOrThrow(tenantId, brandId);
    if (!conn.lastTestPaymentId) throw new BadRequestException("No test payment yet — press Test payment first.");
    const token = await this.accessToken(conn);
    const path = `/v2/payments/${encodeURIComponent(conn.lastTestPaymentId)}`;
    let p = await this.api.request<any>(token, "GET", path, { query: { testmode: "true" } });
    let refundStatus: string | null = null;
    if (refund && p.status === "paid" && !(Number(p.amountRefunded?.value ?? 0) > 0)) {
      const r = await this.api.request<{ id: string; status: string }>(token, "POST", `${path}/refunds`, {
        idempotencyKey: `rf_${p.id}_test`,
        body: { amount: p.amount, description: "OrderHub test refund", testmode: true },
      });
      refundStatus = r.status;
      p = await this.api.request<any>(token, "GET", path, { query: { testmode: "true" } });
    }
    return {
      paymentId: p.id,
      status: p.status as string,
      method: (p.method as string | null) ?? null,
      amount: p.amount,
      applicationFee: p.applicationFee?.amount ?? null,
      amountRefunded: p.amountRefunded ?? null,
      refundStatus,
    };
  }

  /** Turn Mollie on or off for a brand's online payments. */
  async setEnabled(tenantId: string, brandId: string, enabled: boolean) {
    const conn = await (this.prisma as any).mollieConnection.findFirst({
      where: { brandId, tenantId },
    });
    if (!conn) throw new NotFoundException("Connect this brand's Mollie account first.");
    if (enabled) {
      const loc = await this.prisma.location.findFirst({
        where: { brandId, deletedAt: null },
        select: { country: true },
      });
      if (usesTap(loc?.country)) {
        throw new BadRequestException("Mollie can't be used for Gulf shops — they take payments through Tap.");
      }
      if (!conn.refreshTokenEnc) throw new BadRequestException("Connect this brand's Mollie account first.");
      if (!conn.profileId) {
        throw new BadRequestException(
          "This Mollie account has no website profile yet. The restaurant needs to finish onboarding in Mollie, then press Refresh.",
        );
      }
      if (!this.testmode() && !conn.canReceivePayments) {
        throw new BadRequestException(
          "Mollie hasn't approved this account to take payments yet. Press Refresh once they have.",
        );
      }
    }
    const updated = await (this.prisma as any).mollieConnection.update({
      where: { id: conn.id },
      data: { enabled },
    });
    this.logger.log(`Mollie ${enabled ? "enabled" : "disabled"} for brand ${brandId}`);
    return this.view(updated);
  }

  /** Forget a brand's Mollie tokens. Payments already taken are unaffected. */
  async disconnect(tenantId: string, brandId: string) {
    const conn = await (this.prisma as any).mollieConnection.findFirst({
      where: { brandId, tenantId },
    });
    if (!conn) return { ok: true };
    if (conn.refreshTokenEnc && this.configured()) {
      const { clientId, clientSecret } = this.requireApp();
      const refresh = (this.crypto.decrypt(conn.refreshTokenEnc) as { token: string }).token;
      // Best-effort: if Mollie is unreachable we still forget the tokens here.
      await fetch(`${process.env.MOLLIE_API_BASE?.trim() || "https://api.mollie.com"}/oauth2/tokens`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token_type_hint: "refresh_token", token: refresh }).toString(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    await (this.prisma as any).mollieConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: null,
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        enabled: false,
        status: "not_started",
        canReceivePayments: false,
        canReceiveSettlements: false,
      },
    });
    return { ok: true };
  }

  /** Every brand of the tenant with its Mollie state, for the Payments page. */
  async listStatus(tenantId: string) {
    const [brands, conns] = await Promise.all([
      this.prisma.brand.findMany({
        where: { tenantId, deletedAt: null },
        select: { id: true, name: true, locations: { where: { deletedAt: null }, select: { country: true }, take: 1 } } as any,
        orderBy: { name: "asc" },
      }),
      (this.prisma as any).mollieConnection.findMany({ where: { tenantId } }),
    ]);
    const byBrand = new Map<string, any>(conns.map((c: any) => [c.brandId, c]));
    return {
      configured: this.configured(),
      clientLinksAvailable: this.configured() && !!this.platformToken,
      testmode: this.testmode(),
      brands: (brands as any[]).map((b) => ({
        brandId: b.id,
        brandName: b.name,
        // Gulf brands are Tap's; the page shows them greyed out.
        eligible: !usesTap(b.locations?.[0]?.country),
        ...this.view(byBrand.get(b.id)),
      })),
    };
  }

  /**
   * A client link stored before the redirect URI was right still carries the
   * old one, and Mollie refuses any redirect that doesn't match the app's
   * exactly. The link id and signed state are still good, so swap in the
   * current redirect rather than making the operator start again.
   */
  private withCurrentRedirect(url: string): string {
    try {
      const u = new URL(url);
      if (u.searchParams.has("redirect_uri")) u.searchParams.set("redirect_uri", this.redirectUri());
      return u.toString();
    } catch {
      return url;
    }
  }

  /** What the dashboard may see — never a token. */
  private view(conn: any) {
    return {
      status: conn?.status ?? "not_started",
      connected: !!conn?.refreshTokenEnc,
      enabled: !!conn?.enabled,
      organizationName: conn?.organizationName ?? null,
      profileId: conn?.profileId ?? null,
      canReceivePayments: !!conn?.canReceivePayments,
      canReceiveSettlements: !!conn?.canReceiveSettlements,
      onboardingDashboardUrl: conn?.onboardingDashboardUrl ?? null,
      clientLinkUrl: conn?.clientLinkUrl ? this.withCurrentRedirect(conn.clientLinkUrl) : null,
      lastError: conn?.lastError ?? null,
      // { creditcard: "activated" | "pending-review" | …, applepay: … }
      methodStatuses: conn?.methodStatuses ?? null,
    };
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /**
   * The brand's Mollie connection if its online payments go through Mollie,
   * else null (→ Stripe). Never throws: a broken Mollie row must leave the
   * shop on Stripe, not stop it taking cards.
   */
  async activeConnectionForBrand(brandId: string | null | undefined): Promise<any | null> {
    if (!brandId || !this.configured()) return null;
    try {
      const conn = await (this.prisma as any).mollieConnection.findUnique({ where: { brandId } });
      if (!conn?.enabled || !conn.refreshTokenEnc || !conn.profileId) return null;
      return conn;
    } catch {
      return null;
    }
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  /**
   * Start a Mollie hosted checkout for one order.
   *
   * Hosted, like Tap: Mollie's page shows card, Apple Pay and every other
   * method the restaurant has enabled, each with its own 3-D Secure step.
   * Nothing is settled here — only the webhook (or a reconcile read) marks
   * the order paid.
   */
  async createPayment(params: {
    tenantId: string;
    orderId: string;
    redirectUrl: string;
    cancelUrl?: string;
    source: "storefront" | "payment_link";
  }): Promise<{ paymentId: string; checkoutUrl: string; amount: number; currency: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            country: true,
            currency: true,
            brandId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          },
        },
        brand: {
          select: {
            id: true,
            name: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          },
        },
      } as any,
    });
    if (!order) throw new NotFoundException("Order not found");
    const o = order as any;
    const brandId: string | null = o.brandId ?? o.location?.brandId ?? null;
    const conn = await this.activeConnectionForBrand(brandId);
    if (!conn) {
      throw new BadRequestException(
        "This restaurant's Mollie account isn't ready to take payments. Please choose Cash, or contact the restaurant.",
      );
    }

    const currency = (o.location?.currency || currencyForCountry(o.location?.country)).toUpperCase();
    const basket = roundToCurrency(Number(order.total), currency);
    const { platformFee, customerSurcharge } = feeBreakdown(o.brand, o.location, basket, currency);
    // The fixed part of the fee is a surcharge ON TOP of the basket, so it has
    // to be in the amount as well as in our cut — otherwise it quietly comes
    // out of the restaurant, the opposite of what the setting means.
    const charged = roundToCurrency(basket + customerSurcharge, currency);
    // Mollie refuses a fee that eats the whole payment (and caps it at the
    // amount minus its own costs); a fee that large is a misconfiguration,
    // so take none rather than fail the customer's payment.
    const fee = platformFee > 0 && platformFee < charged * 0.5 ? platformFee : 0;
    if (platformFee > 0 && fee === 0) {
      this.logger.warn(`Mollie: platform fee ${platformFee} on ${charged} ${currency} for order ${order.id} is implausible — taking none`);
    }

    const brandName = o.brand?.name ?? o.location?.name ?? "Order";
    const token = await this.accessToken(conn);
    const payment = await this.api.request<MolliePayment>(token, "POST", "/v2/payments", {
      // A double-tapped Pay button must be one payment, not two.
      idempotencyKey: `ord_${order.id}_${params.source}`,
      body: {
        amount: mollieAmount(charged, currency),
        description:
          `${brandName} — ${order.displayId ?? order.id}` +
          (customerSurcharge > 0 ? ` (incl. ${customerSurcharge.toFixed(2)} service charge)` : ""),
        redirectUrl: params.redirectUrl,
        ...(params.cancelUrl ? { cancelUrl: params.cancelUrl } : {}),
        webhookUrl: this.webhookUrl(),
        locale: "en_GB",
        // Online ordering offers card and Apple Pay only (Google Pay rides
        // inside "creditcard" on Mollie's page — it has no method id of its
        // own). An array keeps Mollie's chooser but hides every other method
        // the restaurant may have switched on (PayPal, Klarna, bank
        // transfer…), none of which our order flow is built around.
        ...(params.source === "storefront" ? { method: STOREFRONT_METHODS } : {}),
        metadata: {
          orderId: order.id,
          tenantId: params.tenantId,
          locationId: order.locationId ?? "",
          brandId: brandId ?? "",
          source: params.source,
        },
        profileId: conn.profileId,
        ...(this.testmode() ? { testmode: true } : {}),
        ...(fee > 0
          ? {
              applicationFee: {
                amount: mollieAmount(fee, currency),
                description: `OrderHub fee ${order.displayId ?? order.id}`.slice(0, 255),
              },
            }
          : {}),
      },
    });

    const checkoutUrl = payment._links?.checkout?.href;
    if (!checkoutUrl) {
      this.logger.error(`Mollie payment ${payment.id} came back with no checkout link (status ${payment.status})`);
      throw new BadRequestException("The payment couldn't be started. Please try again.");
    }

    await (this.prisma as any).payment
      .create({
        data: {
          tenantId: params.tenantId,
          orderId: order.id,
          provider: "MOLLIE",
          providerChargeId: payment.id,
          amount: charged,
          currency: currency.toLowerCase(),
          status: "PENDING",
          method: "CARD",
          platformFee: fee,
          processingFee: 0,
          netAmount: roundToCurrency(charged - fee, currency),
          metadata: {
            source: params.source === "payment_link" ? "mollie_payment_link" : "mollie_storefront",
            molliePaymentId: payment.id,
            mollieBrandId: brandId,
            mollieOrganizationId: conn.organizationId,
            mollieProfileId: conn.profileId,
            mollieTestmode: this.testmode(),
          },
        },
      })
      .catch((err: any) => {
        // Same id back from an idempotent replay: the existing row is the one
        // the webhook will settle.
        if (String(err?.code) === "P2002") return;
        throw err;
      });

    return { paymentId: payment.id, checkoutUrl, amount: charged, currency };
  }

  /** Read a Mollie payment back with the restaurant's token. */
  private async fetchPayment(paymentRow: any): Promise<MolliePayment | null> {
    const brandId = (paymentRow.metadata as any)?.mollieBrandId;
    const conn = brandId
      ? await (this.prisma as any).mollieConnection.findUnique({ where: { brandId } })
      : null;
    if (!conn?.refreshTokenEnc) {
      this.logger.warn(`Mollie payment ${paymentRow.providerChargeId}: no connection to read it with`);
      return null;
    }
    const token = await this.accessToken(conn);
    const testmode = (paymentRow.metadata as any)?.mollieTestmode ? "true" : undefined;
    return this.api.request<MolliePayment>(
      token,
      "GET",
      `/v2/payments/${encodeURIComponent(paymentRow.providerChargeId)}`,
      { query: { testmode } },
    );
  }

  /**
   * Mollie's webhook carries ONLY the payment id — never a status. That is the
   * whole security model: we read the payment back from Mollie with the
   * restaurant's own token, so a forged POST to this public URL can at most
   * make us re-read a payment's true state.
   */
  async handleWebhook(id: string | undefined): Promise<void> {
    if (!id || !/^tr_[A-Za-z0-9]+$/.test(id)) return;
    const row = await (this.prisma as any).payment.findFirst({
      where: { providerChargeId: id, provider: "MOLLIE" },
    });
    if (!row) {
      this.logger.warn(`Mollie webhook for unknown payment ${id} — ignoring`);
      return;
    }
    const payment = await this.fetchPayment(row);
    if (payment) await this.settle(row, payment);
  }

  /**
   * Apply what Mollie says about a payment. Idempotent: confirmPaymentRow
   * short-circuits a SUCCEEDED row, and Mollie retries webhooks up to ten
   * times, so this WILL run more than once.
   */
  async settle(row: any, payment: MolliePayment): Promise<void> {
    if (payment.id !== row.providerChargeId) return;
    if (payment.status === "paid") {
      // The amount must be what we asked for. A paid payment for less than
      // the order is not this order paid.
      const want = mollieAmount(Number(row.amount), row.currency);
      if (payment.amount?.value !== want.value || payment.amount?.currency !== want.currency) {
        this.logger.error(
          `Mollie payment ${payment.id} paid ${payment.amount?.value} ${payment.amount?.currency}, expected ${want.value} ${want.currency} — not settling`,
        );
        return;
      }
      await this.payments.confirmPaymentRow(row.tenantId, row, payment.id);
      return;
    }
    if (["failed", "canceled", "expired"].includes(payment.status)) {
      await (this.prisma as any).payment.updateMany({
        where: { id: row.id, status: { notIn: ["SUCCEEDED", "REFUNDED"] } },
        data: { status: "FAILED" },
      });
      this.logger.warn(`Mollie payment ${payment.id} ${payment.status} for order ${row.orderId}`);
      return;
    }
    // open / pending / authorized — the customer is mid-payment.
  }

  /**
   * Pull a Mollie-paid order's state back from Mollie — for the customer who
   * is back on the confirmation page before the webhook landed.
   */
  async reconcileOrder(orderId: string): Promise<void> {
    const row = await (this.prisma as any).payment.findFirst({
      where: { orderId, provider: "MOLLIE" },
      orderBy: { createdAt: "desc" },
    });
    if (!row?.providerChargeId || row.status === "SUCCEEDED") return;
    const payment = await this.fetchPayment(row);
    if (payment) await this.settle(row, payment);
  }

  /** Does this order's latest payment belong to Mollie? Routing by the row. */
  async ownsOrderPayment(orderId: string): Promise<boolean> {
    const row = await (this.prisma as any).payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      select: { provider: true },
    });
    return row?.provider === "MOLLIE";
  }

  /**
   * Refund a Mollie-paid order in full. The restaurant's balance funds it;
   * our application fee is not returned (Mollie: fees are non-refundable).
   * No-op when the order has no paid Mollie payment.
   */
  async refundOrder(orderId: string, reason = "Order cancelled"): Promise<void> {
    const row = await (this.prisma as any).payment.findFirst({
      where: { orderId, provider: "MOLLIE", status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
    });
    if (!row?.providerChargeId) return;
    const brandId = (row.metadata as any)?.mollieBrandId;
    const conn = brandId
      ? await (this.prisma as any).mollieConnection.findUnique({ where: { brandId } })
      : null;
    if (!conn) {
      this.logger.error(`Mollie refund for order ${orderId}: no connection for brand ${brandId}`);
      return;
    }
    const token = await this.accessToken(conn);
    const refund = await this.api.request<{ id: string; status: string }>(
      token,
      "POST",
      `/v2/payments/${encodeURIComponent(row.providerChargeId)}/refunds`,
      {
        idempotencyKey: `rf_${row.providerChargeId}_full`,
        body: {
          amount: mollieAmount(Number(row.amount), row.currency),
          description: reason.slice(0, 140),
          ...((row.metadata as any)?.mollieTestmode ? { testmode: true } : {}),
        },
      },
    );
    await (this.prisma as any).payment.update({
      where: { id: row.id },
      data: {
        status: "REFUNDED",
        metadata: { ...(row.metadata as any), mollieRefundId: refund.id },
      },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: "REFUNDED" as any },
    });
    this.logger.log(`Mollie refund ${refund.id} (${refund.status}) for order ${orderId}`);
  }

  /**
   * POS pay-by-link through Mollie, when the order's brand is on Mollie.
   * Null otherwise, so the caller falls through to Stripe.
   */
  async paymentLinkForOrder(tenantId: string, orderId: string): Promise<{ url: string } | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        brandId: true,
        location: { select: { brandId: true, onlineOrderingSlug: true } },
      } as any,
    });
    if (!order) return null;
    const o = order as any;
    const conn = await this.activeConnectionForBrand(o.brandId ?? o.location?.brandId);
    if (!conn) return null;
    const slug = o.location?.onlineOrderingSlug;
    const redirectUrl = slug
      ? `${this.webUrl()}/order/${slug}/confirmation?orderId=${order.id}`
      : `${this.webUrl()}/?paidOrderId=${order.id}`;
    const { checkoutUrl } = await this.createPayment({
      tenantId,
      orderId,
      redirectUrl,
      source: "payment_link",
    });
    return { url: checkoutUrl };
  }
}

/**
 * Same arithmetic as TapService.feeBreakdown / computeFeeBreakdownPence, and
 * it must stay the same: one brand config can't mean different money on
 * different providers. Brand config wins over the location's.
 */
export function feeBreakdown(
  brand: any,
  location: any,
  basket: number,
  currency: string,
): { platformFee: number; customerSurcharge: number } {
  const src =
    brand?.applicationFeeMode && brand.applicationFeeMode !== "none" ? brand : location;
  const mode = String(src?.applicationFeeMode ?? "none");
  if (mode === "none") return { platformFee: 0, customerSurcharge: 0 };
  const usesFixed = mode === "fixed_only" || mode === "fixed_and_percentage";
  const usesPct = mode === "percentage_only" || mode === "fixed_and_percentage";
  const fixed = usesFixed ? Number(src?.applicationFeeFixedAmount ?? 0) : 0;
  const pct = usesPct ? basket * (Number(src?.applicationFeePercentage ?? 0) / 100) : 0;
  return {
    platformFee: roundToCurrency(fixed + pct, currency),
    customerSurcharge: roundToCurrency(fixed, currency),
  };
}

/** Public API base incl. the "/api" prefix — see common/public-api-url. */
export const apiBase = (): string => publicApiBase();
