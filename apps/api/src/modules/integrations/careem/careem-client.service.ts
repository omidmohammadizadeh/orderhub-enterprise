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

/** A failed token request, carrying what Careem actually said. Thrown rather
 *  than logged-and-generalised so the diagnostics page can show the operator
 *  the real reason instead of "could not authenticate". */
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
   * Where we ask for a token.
   *
   * The spec is internally inconsistent about this and it matters: `/token` is
   * listed under `paths`, i.e. on the gateway, while `securitySchemes` gives
   * `tokenUrl: https://identity.careem.com/token`. Their own auth diagram
   * draws the identity provider as a participant separate from the API, which
   * leans the second way.
   *
   * We use the gateway (the spec's `paths` entry) and let CAREEM_TOKEN_URL
   * override it, so if the identity host turns out to be the right one it is
   * an environment variable rather than a deploy.
   */
  get tokenUrl(): string {
    return process.env.CAREEM_TOKEN_URL?.trim() || `${this.baseUrl}/token`;
  }

  private get clientId(): string | null {
    return process.env.CAREEM_CLIENT_ID?.trim() || null;
  }

  private get clientSecret(): string | null {
    return process.env.CAREEM_CLIENT_SECRET?.trim() || null;
  }

  /** Whether Careem is wired up at all. Checked before routing anything to it,
   *  so a missing key is a clear refusal rather than a 500 mid-flow. */
  configured(): boolean {
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
    if (!force && this.pending) return this.pending;

    this.pending = this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    if (!this.configured()) {
      throw new BadRequestException("Careem is not configured.");
    }
    // multipart/form-data — see the note at the top of this file. FormData
    // sets its own boundary, so we must NOT set Content-Type ourselves.
    const form = new FormData();
    form.append("client_id", this.clientId!);
    form.append("client_secret", this.clientSecret!);
    form.append("grant_type", "client_credentials");
    form.append("scope", "pos");

    const res = await fetch(this.tokenUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
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
    init: { method: string; body?: unknown; query?: Record<string, string | undefined> } = {
      method: "GET",
    },
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
      throw new BadRequestException(
        `Careem request failed (${res.status}).`,
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
