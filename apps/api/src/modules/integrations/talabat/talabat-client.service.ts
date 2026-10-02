import { BadRequestException, Injectable, Logger } from "@nestjs/common";

// Phase TB-0 — transport for Delivery Hero's POS Middleware API, which is what
// Talabat restaurant POS partners integrate with.
//
// ── Which API this is ───────────────────────────────────────────────────────
//
// NOT developer.talabat.com. That site is Delivery Hero's Quick-Commerce
// "Local Shops" Partner API (SKUs, barcodes, picking) and its own intro page
// says "Restaurants – you're in the wrong place". Restaurants are documented
// at integration.talabat.com/en/documentation, which links two OpenAPI specs:
//
//   POS Middleware API  — what WE call (this client)
//   POS Plugin API      — what THEY call on us (talabat-plugin.controller.ts)
//
// Both are copied into ~/Downloads/talabat-restaurant-pos/ and everything
// here is read off them, not off prose.
//
// ── Auth ────────────────────────────────────────────────────────────────────
//
//   POST /v2/login   application/x-www-form-urlencoded
//                    username, password, grant_type=client_credentials
//   → { access_token, token_type: "bearer", expires_in: 1800 }
//
// One credential for the whole integration (all tenants, all vendors), issued
// by Talabat PGP-encrypted to our public key once our contact approves the
// credential request. Chains and vendors are scoped by the PATH, not by the
// token — so a vendor's chain code lives on its connection row.
//
// ── Hosts ───────────────────────────────────────────────────────────────────
//
// The spec names exactly one server: staging. Production hosts appear only
// inside example callback URLs (integration-middleware.eu.…) and the Middle
// East one is not stated anywhere. So production REQUIRES TALABAT_API_BASE —
// guessing a host for live orders is not a risk worth taking to save one
// environment variable.

export type TalabatEnv = "staging" | "production";

export const TALABAT_STAGING_BASE = "https://integration-middleware.stg.restaurant-partners.com";

/**
 * Hosts a callback URL may point at.
 *
 * Every order carries its own callbackUrls, and we POST to them with our
 * bearer token. Following an arbitrary URL from a request body would hand our
 * credential to whoever wrote that body, so the host is checked first: Delivery
 * Hero's restaurant-partners domain, or our own sandbox.
 */
const CALLBACK_HOST = /(^|\.)restaurant-partners\.com$/i;

/** Refresh this long before expiry so a request can't start valid and land expired. */
const EXPIRY_SKEW_MS = 60_000;
/** Stop asking after a rejected login — the same credential fails the same way. */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/** A middleware call that came back non-2xx, carrying what they said. */
export class TalabatApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Talabat rejected ${method} ${path} (${status}): ${describeTalabatError(body)}`);
    this.name = "TalabatApiError";
  }

  /** Their error `code`, when the body has one (INVALID_ORDER_STATUS, …). */
  get code(): string | null {
    try {
      const parsed = JSON.parse(this.body);
      return typeof parsed?.code === "string" ? parsed.code : null;
    } catch {
      return null;
    }
  }

  /** The 409 body's `currentState`, which decides whether an accept is retried. */
  get currentState(): string | null {
    try {
      const parsed = JSON.parse(this.body);
      return typeof parsed?.currentState === "string" ? parsed.currentState : null;
    } catch {
      return null;
    }
  }
}

export class TalabatAuthError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Talabat login failed (${status}): ${describeTalabatError(body)}`);
    this.name = "TalabatAuthError";
  }
}

/** Their error bodies are `{ code, message }`; anything else is shown raw. */
export function describeTalabatError(body: string): string {
  try {
    const e = JSON.parse(body) as { code?: string; message?: string; reason?: string };
    const parts = [e.code, e.message ?? e.reason].filter(Boolean);
    if (parts.length) return parts.join(" — ");
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300) || "(empty response)";
}

export interface TalabatRequest {
  method: "GET" | "POST" | "PUT";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  timeoutMs?: number;
}

export interface TalabatResponse<T> {
  status: number;
  data: T;
}

@Injectable()
export class TalabatClientService {
  private readonly logger = new Logger(TalabatClientService.name);
  private cached: { token: string; expiresAt: number } | null = null;
  private cooldownUntil = 0;
  private lastFailure: TalabatAuthError | null = null;
  /** Single-flight: a burst on a cold cache makes ONE login, not one each. */
  private pending: Promise<string> | null = null;

  get env(): TalabatEnv {
    return process.env.TALABAT_ENV === "production" ? "production" : "staging";
  }

  /** Our own sandbox answering as the middleware. Never in production. */
  get sandbox(): boolean {
    return process.env.TALABAT_SANDBOX === "true" && this.env !== "production";
  }

  get baseUrl(): string | null {
    const explicit = process.env.TALABAT_API_BASE?.trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    if (this.sandbox) return `${apiOrigin()}/api/v1/talabat-sandbox/middleware`;
    // Production has no documented host — see the header.
    return this.env === "production" ? null : TALABAT_STAGING_BASE;
  }

  private get username(): string | null {
    if (this.sandbox) return process.env.TALABAT_USERNAME?.trim() || "sandbox";
    return process.env.TALABAT_USERNAME?.trim() || null;
  }

  private get password(): string | null {
    if (this.sandbox) return process.env.TALABAT_PASSWORD?.trim() || "sandbox";
    return process.env.TALABAT_PASSWORD?.trim() || null;
  }

  /** The secret the middleware signs its JWTs with (inbound auth). */
  get pluginSecret(): string | null {
    const s = process.env.TALABAT_PLUGIN_SECRET?.trim();
    if (s) return s;
    // The sandbox signs with a fixed secret of its own so the whole loop can
    // run before Talabat issue a real one.
    return this.sandbox ? SANDBOX_PLUGIN_SECRET : null;
  }

  /** Can we call Talabat at all? Checked before anything is routed to it. */
  configured(): boolean {
    return !!this.baseUrl && !!this.username && !!this.password;
  }

  /** Human-readable reason `configured()` is false, for the diagnostics page. */
  missingConfig(): string[] {
    const out: string[] = [];
    if (!this.baseUrl) {
      out.push("TALABAT_API_BASE (production has no documented host — ask Talabat for it)");
    }
    if (!this.username) out.push("TALABAT_USERNAME");
    if (!this.password) out.push("TALABAT_PASSWORD");
    return out;
  }

  get cooldownSeconds(): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }

  /** Operator action only — never automatic. */
  resetCooldown(): void {
    this.cooldownUntil = 0;
    this.lastFailure = null;
  }

  /** A valid bearer token, cached until shortly before it expires. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    // `force` (a 401 mid-request) deliberately does not bypass the cooldown.
    if (!this.sandbox && Date.now() < this.cooldownUntil && this.lastFailure) {
      throw this.lastFailure;
    }
    if (!force && this.pending) return this.pending;
    this.pending = this.login().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async login(): Promise<string> {
    if (!this.configured()) {
      throw new BadRequestException(
        `Talabat is not configured: missing ${this.missingConfig().join(", ")}.`,
      );
    }
    const res = await fetch(`${this.baseUrl}/v2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        username: this.username!,
        password: this.password!,
        grant_type: "client_credentials",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new TalabatAuthError(res.status, text);
      this.lastFailure = err;
      this.cooldownUntil = Date.now() + (res.status === 429 ? RATE_LIMIT_COOLDOWN_MS : FAILURE_COOLDOWN_MS);
      this.logger.warn(`Talabat login failed (${res.status}); not retrying for ${this.cooldownSeconds}s`);
      throw err;
    }
    let body: { access_token?: string; expires_in?: number };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BadRequestException("Talabat login returned something that is not JSON.");
    }
    if (!body.access_token) throw new BadRequestException("Talabat login returned no access token.");
    this.cooldownUntil = 0;
    this.lastFailure = null;
    // Their example says 1800; default to that if it is ever omitted.
    const ttlMs = (Number(body.expires_in) || 1800) * 1000;
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS),
    };
    this.logger.log(`Talabat token acquired (${this.env}${this.sandbox ? ", sandbox" : ""})`);
    return body.access_token;
  }

  /** A call to a path on the middleware host. */
  async request<T = unknown>(path: string, init: TalabatRequest): Promise<TalabatResponse<T>> {
    if (!this.baseUrl) {
      throw new BadRequestException(`Talabat is not configured: missing ${this.missingConfig().join(", ")}.`);
    }
    const qs = init.query
      ? "?" +
        new URLSearchParams(
          Object.entries(init.query)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]): [string, string] => [k, String(v)]),
        ).toString()
      : "";
    return this.send<T>(`${this.baseUrl}${path}${qs}`, init, path);
  }

  /**
   * POST to one of the absolute callback URLs an order carried.
   *
   * The spec is explicit that status updates go to the URL from the dispatch
   * payload, not to a path we build — "In the cases when the URL is not present
   * you should not be sending us that type of callback". So the URL is the
   * contract, and its absence means "not applicable to this order".
   */
  async callback<T = unknown>(url: string, body?: unknown): Promise<TalabatResponse<T>> {
    const parsed = safeUrl(url);
    if (!parsed) throw new BadRequestException(`Not a usable Talabat callback URL: ${url}`);
    const sandboxOrigin = this.sandbox ? new URL(apiOrigin()).host : null;
    if (!CALLBACK_HOST.test(parsed.hostname) && parsed.host !== sandboxOrigin) {
      // Never send our bearer token to a host we don't recognise.
      throw new BadRequestException(
        `Refusing to call back to ${parsed.host}: not a Delivery Hero middleware host.`,
      );
    }
    return this.send<T>(parsed.toString(), { method: "POST", body }, parsed.pathname);
  }

  private async send<T>(url: string, init: TalabatRequest, label: string): Promise<TalabatResponse<T>> {
    const call = async (token: string) =>
      fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });

    let res = await call(await this.accessToken());
    if (res.status === 401) {
      this.logger.warn(`Talabat ${init.method} ${label} got 401 — refreshing token once`);
      res = await call(await this.accessToken(true));
    }
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`Talabat ${init.method} ${label} failed ${res.status}: ${text.slice(0, 300)}`);
      throw new TalabatApiError(res.status, text, init.method, label);
    }
    let data: T = undefined as T;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    return { status: res.status, data };
  }
}

/** Fixed secret the sandbox signs its fake middleware JWTs with. Not a credential. */
export const SANDBOX_PLUGIN_SECRET = "orderhub-talabat-sandbox-secret";

/** Our public API origin, as Talabat (and our own sandbox) reach it. */
export function apiOrigin(): string {
  const raw = (process.env.API_URL ?? "").trim().replace(/\/+$/, "");
  return raw || "http://localhost:4000";
}

const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

/**
 * The origin Talabat's servers must reach us on — catalog callback URL, the
 * base URL on the activation sheet, image links. A localhost API_URL is no use
 * to them, so it falls back to production (the same rule Glovo and Keeta use).
 * The sandbox is the exception: it is our own server calling itself.
 */
export function publicApiOrigin(): string {
  const own = apiOrigin();
  const sandbox = process.env.TALABAT_SANDBOX === "true" && process.env.TALABAT_ENV !== "production";
  if (sandbox) return own;
  return /localhost|127\.0\.0\.1/.test(own) || !own.startsWith("https://") ? PROD_API_ORIGIN : own;
}

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(String(raw ?? ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}
