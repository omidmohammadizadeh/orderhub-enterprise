import { BadRequestException, Injectable, Logger } from "@nestjs/common";

// Phase CA-0 — Careem POS transport + inbound authentication.
//
// Read off Careem's own OpenAPI spec (POS API 2.1.0), not from prose. Two
// things in it are unusual enough to be worth stating rather than discovering:
//
// 1. THE TOKEN REQUEST IS multipart/form-data. Every other OAuth2
//    client_credentials endpoint we integrate takes
//    application/x-www-form-urlencoded, and sending that here is the kind of
//    mistake that returns a bare 400 with nothing to go on. The spec is
//    explicit: `requestBody.content["multipart/form-data"]`, with client_id,
//    client_secret, grant_type (client_credentials ONLY) and scope (pos ONLY).
//
// 2. INBOUND WEBHOOKS ARE NOT SIGNED. There is no HMAC anywhere in the spec —
//    Careem sends a STATIC shared secret in an `x-careem-api-key` header and
//    that is the whole of the authentication. It proves the sender knows the
//    key; it says nothing about the body. So it is compared in constant time
//    here, and callers must ALSO dedupe on order id, because a static header
//    makes replay trivial in a way an HMAC over the body would not.
//
// Careem provisions the webhook URL and that key themselves — from their FAQ,
// "please provide the webhook URL and the associated secret to the engineering
// team" — so neither is self-serve in the partner portal.

/** Careem's identity provider. Shared across environments — the client_id
 *  determines which one you get a token for. */
// The identity provider is PER ENVIRONMENT. Careem's POS API 2.1.0 spec gives
// /token its own `servers` block, separate from the gateway's:
//
//   production  https://identity.careem.com
//   staging     https://identity.qa.careem-engineering.com
//
// We had only the production host and used it for both, so staging
// credentials were being presented to the production identity server. It
// answers "Bad credentials", which is correct and unhelpful: the credentials
// are real, they are simply unknown to that host.
const IDENTITY_TOKEN_URL = "https://identity.careem.com/token";
const IDENTITY_TOKEN_URL_STAGING =
  "https://identity.qa.careem-engineering.com/token";

/** Careem lists User-Agent as a REQUIRED header on every POS endpoint, beside
 *  Authorization. Node's fetch does not reliably send one on its own, and a
 *  gateway rejecting an absent User-Agent fails in a way that looks nothing
 *  like a missing header — so it is set explicitly and identifies us. */
const USER_AGENT = "OrderHub/1.0 (+https://www.orderhubsolutions.com)";

/**
 * How we present ourselves to the token endpoint.
 *
 * Three axes, because Careem's two documents disagree on all three and only
 * one combination can be right:
 *
 *   transport — the POS spec says multipart/form-data; the Identity guide's
 *               S2S curl says application/x-www-form-urlencoded.
 *   auth      — RFC 6749 allows the id/secret in the body
 *               (client_secret_post) or an Authorization header
 *               (client_secret_basic). Servers rarely take both.
 *   scope     — the POS spec calls `scope=pos` required and the only accepted
 *               value. The Identity guide's S2S table lists exactly three
 *               mandatory fields — grant_type, client_id, client_secret — and
 *               NO scope at all.
 *
 * Ordered so the Identity guide's literal curl goes first: it is the document
 * that actually describes this token endpoint, and the POS spec has already
 * been wrong once about where the endpoint even is.
 */
export const AUTH_VARIANTS = [
  "form_post_noscope", // exactly the Identity guide's S2S curl
  "form_post", // …plus scope=pos, per the POS spec
  "multipart_post", // the POS spec's content type
  "form_basic_noscope",
  "form_basic",
  "multipart_basic",
] as const;
export type AuthVariant = (typeof AUTH_VARIANTS)[number];

const basicAuth = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

/** Is the server complaining about who we say we are, rather than anything
 *  else? Only then is trying another style meaningful. */
export function isClientAuthFailure(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  return /invalid_client|unauthorized_client|invalid_scope|client authentication|bad credentials/i.test(
    body,
  );
}

const HOSTS = {
  production: "https://apigateway.careemdash.com/pos/api/v1",
  staging: "https://apigateway-stg.careemdash.com/pos/api/v1",
} as const;

export type CareemEnv = keyof typeof HOSTS;

/** Refresh this far before the token actually expires, so a long request
 *  can't start on a valid token and finish on an expired one. */
const EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * How long to stop asking after a failed token request.
 *
 * Careem's docs are explicit: "do not try to request a new token every time you
 * do an API request. This might potentially lead to unneeded rate-limiting or
 * even IP block and might require manual intervention." A credential that was
 * rejected a second ago will be rejected again, so retrying it on a timer buys
 * nothing and spends the one budget that is genuinely hard to get back.
 *
 * A 429 gets a much longer cooldown, because at that point the endpoint is
 * already telling us to stop and every further attempt digs the hole deeper.
 */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/** A failed token request, carrying what Careem actually said. Thrown rather
 *  than logged-and-generalised so the diagnostics page can show the operator
 *  the real reason instead of "could not authenticate". */
/**
 * A rejected API call, carrying what Careem actually said.
 *
 * Their errors are specific and several map to a fix in their own FAQ —
 * "branch_id is not mapped" means ask their operations team, "Name cannot be
 * blank!" names the entity. Reducing all of that to "request failed (400)"
 * throws away the only part worth reading.
 */
export class CareemApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(
      `Careem rejected ${method} ${path} (${status}): ${describeCareemError(body)}`,
    );
    this.name = "CareemApiError";
  }
}

/**
 * Their error body as one readable line.
 *
 * Validation errors nest — {errors: [{field, errors: [{message}]}]} — and the
 * useful part is two levels down. Anything unrecognised falls back to the raw
 * text rather than being swallowed.
 */
export function describeCareemError(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 300) || "(empty response)";
  }
  const e = parsed as {
    message?: string;
    code?: string;
    errors?: Array<{
      field?: string;
      reason?: string;
      errors?: Array<{ message?: string }>;
    }> | null;
  };
  const detail = (e.errors ?? [])
    .map((group) => {
      const messages = (group.errors ?? [])
        .map((x) => x.message)
        .filter(Boolean)
        // The same message repeated per offending row is noise; one is enough.
        .filter((m, i, all) => all.indexOf(m) === i)
        .join("; ");
      const text = messages || group.reason || "";
      return group.field ? `${group.field}: ${text}` : text;
    })
    .filter(Boolean)
    .join(" | ");

  const head = e.message ?? e.code ?? "";
  if (head && detail) return `${head} — ${detail}`;
  return head || detail || body.slice(0, 300);
}

export class CareemAuthError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly tokenUrl: string,
  ) {
    super(`Careem token request failed (${status}) at ${tokenUrl}`);
    this.name = "CareemAuthError";
  }
}

@Injectable()
export class CareemClientService {
  private readonly logger = new Logger(CareemClientService.name);
  private cached: CachedToken | null = null;
  /** Set after a failure; blocks further attempts until it passes. */
  private cooldownUntil = 0;
  private lastFailure: CareemAuthError | null = null;
  /** In-flight token request, so a burst of calls on a cold cache makes ONE
   *  round trip rather than one per caller. */
  private pending: Promise<string> | null = null;

  get env(): CareemEnv {
    return process.env.CAREEM_ENV === "production" ? "production" : "staging";
  }

  get baseUrl(): string {
    return process.env.CAREEM_API_BASE?.trim() || HOSTS[this.env];
  }

  /**
   * Where we ask for a token — the IDENTITY provider, not the API gateway.
   *
   * `/token` appears under `paths`, which puts it on the gateway, but it
   * carries its own `servers` block naming the identity hosts instead.
   * Tested against both:
   *
   *   POST {gateway}/token           → 404, a bare Symfony NotFoundHttpException
   *   POST {identity}/token          → speaks OAuth2
   *
   * The correction that matters: there are TWO identity hosts, one per
   * environment, and we previously used the production one for both. Staging
   * credentials sent to the production identity server come back "Bad
   * credentials" — a true statement about that host, and a completely
   * misleading one about the credentials, which cost us months of chasing a
   * provisioning problem that may never have existed.
   */
  get tokenUrl(): string {
    if (process.env.CAREEM_TOKEN_URL?.trim()) {
      return process.env.CAREEM_TOKEN_URL.trim();
    }
    // In the sandbox the token has to come from the sandbox. Pointing only
    // CAREEM_API_BASE at the mock left this asking the real identity provider
    // for a token, which is exactly the request we have no credentials for —
    // so every call failed at the first step, before reaching the mock at all.
    if (this.sandbox) return `${this.baseUrl}/token`;
    return this.env === "production"
      ? IDENTITY_TOKEN_URL
      : IDENTITY_TOKEN_URL_STAGING;
  }

  /** Mirrors CareemSandboxService.enabled. Duplicated rather than injected
   *  because the client is what the sandbox service's own callers depend on,
   *  and a cycle here would be worse than one repeated condition. */
  private get sandbox(): boolean {
    return (
      process.env.CAREEM_SANDBOX === "true" &&
      process.env.CAREEM_ENV !== "production"
    );
  }

  private get clientId(): string | null {
    if (this.sandbox) return process.env.CAREEM_CLIENT_ID?.trim() || "sandbox";
    return process.env.CAREEM_CLIENT_ID?.trim() || null;
  }

  private get clientSecret(): string | null {
    if (this.sandbox) return process.env.CAREEM_CLIENT_SECRET?.trim() || "sandbox";
    return process.env.CAREEM_CLIENT_SECRET?.trim() || null;
  }

  /** Whether Careem is wired up at all. Checked before routing anything to it,
   *  so a missing key is a clear refusal rather than a 500 mid-flow. */
  configured(): boolean {
    // The sandbox exists precisely because Careem have not issued us a client,
    // so requiring one to use it would defeat the point.
    if (this.sandbox) return true;
    return !!this.clientId && !!this.clientSecret;
  }

  /**
   * A valid bearer token, cached until shortly before it expires.
   *
   * `force` skips the cache — for the single retry after a 401, where the
   * token was accepted by us but rejected by Careem (revoked credentials, or a
   * clock far enough out that our skew didn't cover it).
   */
  async accessToken(force = false): Promise<string> {
    if (!force && this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    // Re-throw the last failure rather than asking again. `force` deliberately
    // does NOT bypass this: the reason a caller forces is a 401 mid-request,
    // and hammering a rejecting endpoint is what gets an IP blocked.
    // The cooldown protects Careem's IP allowance. The sandbox is our own
    // server, so there is nothing to protect — and a cooldown left over from
    // real credentials failing would otherwise block the sandbox for minutes.
    if (!this.sandbox && Date.now() < this.cooldownUntil && this.lastFailure) {
      throw this.lastFailure;
    }
    if (!force && this.pending) return this.pending;

    this.pending = this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Seconds until we will try again, or 0 if we would try now. Surfaced so an
   *  operator seeing a stale error understands it is not being re-checked. */
  get cooldownSeconds(): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }

  /** Clears the cooldown so the next call really asks Careem. Behind an
   *  explicit operator action — never automatic. */
  resetCooldown(): void {
    this.cooldownUntil = 0;
    this.lastFailure = null;
  }

  /**
   * How the client authenticates itself to the token endpoint.
   *
   * RFC 6749 allows two, and servers rarely accept both: `client_secret_post`
   * puts the id and secret in the body, `client_secret_basic` puts them in an
   * Authorization header. `invalid_client` is precisely the error for "client
   * authentication failed", so when the credentials are known-good it usually
   * means the server wanted the other one.
   *
   * Careem's spec documents the body form (multipart), and their spec was
   * already wrong about the token URL, so we try it first and fall back rather
   * than trusting it. Whichever works is remembered, so the fallback costs one
   * extra round trip once per process rather than on every token.
   */
  private authVariant: AuthVariant | null = null;

  private buildTokenRequest(variant: AuthVariant): RequestInit {
    const id = this.clientId!;
    const secret = this.clientSecret!;
    const multipart = variant.startsWith("multipart");
    const basic = variant.includes("basic");
    const withScope = !variant.endsWith("noscope");

    const fields: Record<string, string> = { grant_type: "client_credentials" };
    if (withScope) fields.scope = "pos";
    if (!basic) {
      fields.client_id = id;
      fields.client_secret = secret;
    }

    if (multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      // FormData sets its own boundary — never set Content-Type by hand.
      return {
        method: "POST",
        body: form,
        headers: {
          "User-Agent": USER_AGENT,
          ...(basic ? { Authorization: basicAuth(id, secret) } : {}),
        },
      };
    }

    return {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        ...(basic ? { Authorization: basicAuth(id, secret) } : {}),
      },
    };
  }

  /**
   * Try every client-authentication variant against the token endpoint and
   * report what each one did.
   *
   * The same idea as JET's signature-variant diagnostic: when authentication
   * fails there are only a handful of ways it can be wrong, and trying them all
   * once turns a day of guessing into one line of output. Never returns a
   * credential — only the status and the server's reply.
   */
  async diagnoseAuth(): Promise<
    Array<{ variant: AuthVariant; status: number; ok: boolean; body: string }>
  > {
    if (!this.configured()) {
      throw new BadRequestException("Careem is not configured.");
    }
    const out = [];
    for (const variant of AUTH_VARIANTS) {
      try {
        const res = await fetch(this.tokenUrl, {
          ...this.buildTokenRequest(variant),
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.text();
        out.push({
          variant,
          status: res.status,
          ok: res.ok,
          body: body.slice(0, 400),
        });
        // Stop dead on a rate limit. Continuing to walk the list while the
        // endpoint is actively refusing us is how a temporary throttle becomes
        // an IP block their docs say needs manual intervention to undo.
        if (res.status === 429) break;
        if (res.ok) break;
      } catch (err) {
        out.push({
          variant,
          status: 0,
          ok: false,
          body: (err as Error).message,
        });
      }
    }
    return out;
  }

  private async requestToken(): Promise<string> {
    if (!this.configured()) {
      throw new BadRequestException("Careem is not configured.");
    }
    // Remembered winner first; otherwise the spec's documented shape, then the
    // alternatives. Stops at the first success.
    const order = this.authVariant
      ? [this.authVariant]
      : [...AUTH_VARIANTS];

    let last: { status: number; text: string } | null = null;
    let res!: Response;
    let text = "";
    for (const variant of order) {
      res = await fetch(this.tokenUrl, {
        ...this.buildTokenRequest(variant),
        signal: AbortSignal.timeout(15_000),
      });
      text = await res.text();
      if (res.ok) {
        if (this.authVariant !== variant) {
          this.logger.log(`Careem accepted client auth variant "${variant}"`);
        }
        this.authVariant = variant;
        break;
      }
      last = { status: res.status, text };
      // Only worth trying another variant when the server is specifically
      // complaining about CLIENT AUTHENTICATION. A 404 or a 500 means
      // something else is wrong and retrying four ways just makes noise.
      if (!isClientAuthFailure(res.status, text)) break;
    }
    if (!res.ok && last) {
      text = last.text;
    }
    if (!res.ok) {
      const err = new CareemAuthError(
        last?.status ?? res.status,
        text,
        this.tokenUrl,
      );
      this.lastFailure = err;
      this.cooldownUntil =
        Date.now() +
        (err.status === 429 ? RATE_LIMIT_COOLDOWN_MS : FAILURE_COOLDOWN_MS);
      this.logger.warn(
        `Careem token failed (${err.status}); not retrying for ${Math.round(
          (this.cooldownUntil - Date.now()) / 1000,
        )}s`,
      );
      throw err;
    }
    this.cooldownUntil = 0;
    this.lastFailure = null;
    if (!res.ok) {
      this.logger.error(
        `Careem token request failed ${res.status} at ${this.tokenUrl}: ${text.slice(0, 500)}`,
      );
      // Careem's own words, not ours. Their errors are specific and
      // actionable — "clients not found for client_id=…" means the webhook
      // isn't configured for this environment, per their FAQ — and swallowing
      // that behind "Could not authenticate" turns a five-minute fix into a
      // support thread.
      throw new CareemAuthError(res.status, text, this.tokenUrl);
    }
    let body: {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    try {
      body = JSON.parse(text);
    } catch {
      this.logger.error(`Careem token response was not JSON: ${text.slice(0, 200)}`);
      throw new BadRequestException("Careem returned an unexpected token response.");
    }
    if (!body.access_token) {
      throw new BadRequestException("Careem returned no access token.");
    }
    // Default to an hour if they omit expires_in — short enough to be safe,
    // long enough not to hammer the endpoint.
    const ttlMs = (Number(body.expires_in) || 3600) * 1000;
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS),
    };
    this.logger.log(
      `Careem token acquired (${this.env}), valid ~${Math.round(ttlMs / 1000)}s`,
    );
    return body.access_token;
  }

  /**
   * An authenticated call to the POS API.
   *
   * Retries ONCE on a 401 with a forced fresh token: the common cause is a
   * token that expired between our skew window and Careem's clock, and
   * re-authenticating costs one round trip against failing an order accept.
   */
  async request<T>(
    path: string,
    init: {
      method: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
      /** Careem scopes most endpoints by header, not by path. Branch, catalog
       *  and order calls all require Branch-Id, and most require Brand-Id. */
      brandId?: string;
      branchId?: string;
    } = { method: "GET" },
  ): Promise<T> {
    const doCall = async (token: string) => {
      const qs = init.query
        ? "?" +
          new URLSearchParams(
            Object.entries(init.query).filter(([, v]) => v != null) as [string, string][],
          ).toString()
        : "";
      return fetch(`${this.baseUrl}${path}${qs}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          accept: "application/json",
          // REQUIRED on every POS endpoint — their docs list it beside
          // Authorization on all of them. Node's fetch does not reliably send
          // one, and a gateway that rejects an absent User-Agent does it with
          // an error that looks nothing like "you forgot a header".
          "User-Agent": USER_AGENT,
          ...(init.brandId ? { "Brand-Id": init.brandId } : {}),
          ...(init.branchId ? { "Branch-Id": init.branchId } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    };

    let res = await doCall(await this.accessToken());
    if (res.status === 401) {
      this.logger.warn(`Careem ${init.method} ${path} got 401 — refreshing token once`);
      res = await doCall(await this.accessToken(true));
    }

    const text = await res.text();
    if (!res.ok) {
      this.logger.error(
        `Careem ${init.method} ${path} failed ${res.status}: ${text.slice(0, 400)}`,
      );
      throw new CareemApiError(
        res.status,
        text,
        init.method ?? "GET",
        path,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }
}
