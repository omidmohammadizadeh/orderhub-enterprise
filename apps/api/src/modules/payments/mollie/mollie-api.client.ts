import { BadRequestException, Logger } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { currencyDecimals } from "@orderhub/shared";

// Mollie's two hosts: the REST API, and the dashboard that serves the OAuth
// consent screen. Tokens are minted on the API host.
export const MOLLIE_API_BASE = "https://api.mollie.com";
export const MOLLIE_AUTHORIZE_URL = "https://my.mollie.com/oauth2/authorize";

/**
 * What we ask a restaurant's Mollie account to let us do.
 *
 * Mollie can't widen a grant later: a scope added after the restaurant has
 * connected means asking them to connect again (docs, "Setting up OAuth"). So
 * this asks for everything the integration uses up front — taking and
 * refunding payments, setting up the website profile we charge on, and
 * reading onboarding / balance / settlement state for the dashboard.
 */
export const MOLLIE_SCOPES = [
  "payments.read",
  "payments.write",
  "refunds.read",
  "refunds.write",
  "profiles.read",
  "profiles.write",
  "onboarding.read",
  "organizations.read",
  "balances.read",
  "settlements.read",
] as const;

/** Mollie payment status values (Get payment). Only `paid` means money moved. */
export type MolliePaymentStatus =
  | "open"
  | "pending"
  | "authorized"
  | "paid"
  | "canceled"
  | "expired"
  | "failed";

export type MollieAmount = { currency: string; value: string };

export type MolliePayment = {
  id: string;
  status: MolliePaymentStatus;
  amount: MollieAmount;
  amountRefunded?: MollieAmount;
  metadata?: Record<string, unknown> | null;
  profileId?: string;
  mode?: "test" | "live";
  _links?: { checkout?: { href: string } };
};

export type MollieTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export type MollieOnboarding = {
  name?: string;
  status: "needs-data" | "in-review" | "completed";
  canReceivePayments: boolean;
  canReceiveSettlements: boolean;
  _links?: { dashboard?: { href: string } };
};

/**
 * Mollie's money format: a STRING with exactly the currency's decimals.
 * "12.5" is rejected, as is 12.5. Built from minor units so a float never
 * decides the last digit.
 */
export function mollieAmount(value: number, currency: string): MollieAmount {
  const cur = currency.toUpperCase();
  const decimals = currencyDecimals(cur);
  const minor = Math.round(value * 10 ** decimals);
  return { currency: cur, value: (minor / 10 ** decimals).toFixed(decimals) };
}

/**
 * The OAuth `state` round trip, without a table.
 *
 * Carries which brand of which tenant the consent is for, signed with our
 * client secret and stamped with an expiry. The callback is public — the
 * browser arrives from Mollie with no session — so this signature is the only
 * thing stopping someone attaching THEIR Mollie account to another tenant's
 * brand by hand-editing the query string.
 */
export function signOAuthState(
  payload: { tenantId: string; brandId: string },
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 30, // client links live 30 days, so the state must too
): string {
  const body = Buffer.from(
    JSON.stringify({
      t: payload.tenantId,
      b: payload.brandId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      n: randomBytes(6).toString("hex"),
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOAuthState(
  state: string | undefined,
  secret: string,
): { tenantId: string; brandId: string } | null {
  if (!state || !state.includes(".")) return null;
  const [body = "", sig = ""] = state.split(".", 2);
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p?.t || !p?.b || typeof p.exp !== "number") return null;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return { tenantId: String(p.t), brandId: String(p.b) };
  } catch {
    return null;
  }
}

/**
 * Thin fetch wrapper over Mollie's REST API.
 *
 * Errors come back as RFC 7807 problem documents (`title`, `detail`, `field`).
 * `detail` is what an operator can act on ("The amount is lower than the
 * minimum"), so that is what is thrown; the full body goes to the log.
 */
export class MollieApiClient {
  private readonly logger = new Logger("MollieApi");

  constructor(private readonly base = MOLLIE_API_BASE) {}

  async request<T>(
    token: string,
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null) qs.set(k, v);
    const url = `${this.base}${path}${qs.toString() ? `?${qs}` : ""}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/hal+json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      this.logger.error(`Mollie ${method} ${path} didn't reach Mollie: ${err?.message ?? err}`);
      throw new BadRequestException("Couldn't reach Mollie just now. Please try again in a moment.");
    }
    return this.parse<T>(res, `${method} ${path}`);
  }

  /** POST /oauth2/tokens — Basic auth with the app's id and secret, form body. */
  async tokens(
    clientId: string,
    clientSecret: string,
    form: Record<string, string>,
  ): Promise<MollieTokens> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/oauth2/tokens`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      this.logger.error(`Mollie token call didn't reach Mollie: ${err?.message ?? err}`);
      throw new BadRequestException("Couldn't reach Mollie just now. Please try again in a moment.");
    }
    return this.parse<MollieTokens>(res, `POST /oauth2/tokens (${form.grant_type})`);
  }

  private async parse<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      this.logger.error(`Mollie ${what} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
      throw new BadRequestException("Mollie returned an unexpected response.");
    }
    if (!res.ok) {
      const detail = body?.detail ?? body?.error_description ?? body?.error ?? text.slice(0, 200);
      this.logger.error(
        `Mollie ${what} failed ${res.status}: ${body?.title ?? ""} ${detail}${body?.field ? ` (field ${body.field})` : ""}`,
      );
      throw new BadRequestException(
        typeof detail === "string" && detail ? `Mollie: ${detail}` : "The Mollie request failed.",
      );
    }
    return body as T;
  }
}
