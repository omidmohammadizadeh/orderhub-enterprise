import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

// Phase GL-1 — Glovo restaurant Partners API transport + inbound auth.
//
// Source: https://api-docs.glovoapp.com/partners/definition.yaml (saved as
// ~/Downloads/glovo-restaurant-partners-api-2026-09-19.yaml).
//
// AUTH IS ONE STATIC SHARED TOKEN, NOT OAUTH. Their words: "Access token is
// static for each environment and webhook… The same token will be used for all
// the stores configured." It goes in `Authorization` exactly as issued — the
// spec's example is `Authorization: token`, no `Bearer` — and Glovo sends the
// same header back on every webhook, which is the webhooks' only
// authentication. There is no HMAC and no fixed source IP ("There won't be a
// unique IP… whitelisting us by the Authorization header").
//
// Hosts: stage https://stageapi.glovoapp.com, production https://api.glovoapp.com.
// Stage and production tokens are different; a stage token against the
// production host is a 401, which is what GLOVO_ENV guards against.
//
// Rate limit: 120 requests/minute summed per store address, 429 beyond it.

export type GlovoEnv = "stage" | "production";

const HOSTS: Record<GlovoEnv, string> = {
  stage: "https://stageapi.glovoapp.com",
  production: "https://api.glovoapp.com",
};

export interface GlovoRequestOptions {
  body?: unknown;
  /** Extra headers, e.g. Glovo-Store-Address-External-Id on the v0 endpoints. */
  headers?: Record<string, string>;
  /**
   * Retries on 429 / 5xx / network error. Defaults to 0 (fail fast). A 4xx
   * other than 429 is never retried — asking again does not change the answer.
   */
  retries?: number;
  retryDelayMs?: number;
}

/** A Glovo call that answered non-2xx, with the status kept for callers. */
export class GlovoApiError extends BadRequestException {
  constructor(
    readonly httpStatus: number,
    readonly responseText: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Constant-time compare of a presented Authorization header against the
 * expected token. Tolerates a `Bearer ` prefix: the spec documents none, but a
 * sender adding one is not an attack and rejecting it would drop live orders.
 */
export function glovoTokenMatches(
  expected: string,
  presented: string | undefined | null,
): boolean {
  if (!expected) return false;
  const value = String(presented ?? "")
    .replace(/^\s*Bearer\s+/i, "")
    .trim();
  if (!value) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

@Injectable()
export class GlovoClientService {
  private readonly logger = new Logger(GlovoClientService.name);

  constructor(private readonly config: ConfigService) {}

  private cfg(key: string): string {
    return String(this.config.get(`app.platforms.glovo.${key}`) ?? "");
  }

  get env(): GlovoEnv {
    return this.cfg("env") === "production" ? "production" : "stage";
  }

  /** True when we hold a token and can call Glovo at all. */
  get configured(): boolean {
    return !!this.cfg("apiToken");
  }

  get baseUrl(): string {
    return (this.cfg("baseUrl") || HOSTS[this.env]).replace(/\/+$/, "");
  }

  /** The value we expect in `Authorization` on Glovo's webhooks. */
  private inboundToken(): string {
    return this.cfg("webhookToken") || this.cfg("apiToken");
  }

  /** True when inbound webhooks are actually authenticated. */
  get inboundTokenConfigured(): boolean {
    return !!this.inboundToken();
  }

  /**
   * Is this webhook really from Glovo?
   *
   * Returns true when no token is configured at all — rejecting every order on
   * a fresh deploy would drop live food on the floor, and Glovo still shows the
   * order on the store's own Partner Webapp. The receiver logs that state
   * loudly and the public health probe reports it.
   */
  verifyInboundToken(authorization: string | undefined | null): boolean {
    const expected = this.inboundToken();
    if (!expected) return true;
    return glovoTokenMatches(expected, authorization);
  }

  /**
   * Authenticated request against Glovo. `path` starts with "/".
   *
   * Returns the parsed JSON body, or null for an empty 2xx (status updates and
   * closing answer 204).
   */
  async request<T = any>(
    method: string,
    path: string,
    opts: GlovoRequestOptions = {},
  ): Promise<T> {
    const token = this.cfg("apiToken");
    if (!token) {
      throw new BadRequestException(
        "Glovo isn't configured on the server: GLOVO_API_TOKEN is not set.",
      );
    }

    const url = `${this.baseUrl}${path}`;
    const call = () =>
      fetch(url, {
        method,
        headers: {
          Authorization: token,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });

    const maxAttempts = Math.max(1, (opts.retries ?? 0) + 1);
    const baseDelay = opts.retryDelayMs ?? 500;
    let lastStatus = 0;
    let lastText = "";
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await call();
        lastStatus = res.status;
        lastText = await res.text();
        if (res.ok) {
          this.logger.log(`Glovo ${method} ${path} → ${res.status} (${this.env})`);
          if (!lastText) return null as T;
          try {
            return JSON.parse(lastText) as T;
          } catch {
            return lastText as unknown as T;
          }
        }
        lastError = `${res.status}: ${lastText.slice(0, 300)}`;
        if (res.status < 500 && res.status !== 429) break;
      } catch (e: any) {
        lastStatus = 0;
        lastError = `network: ${e?.message ?? e}`;
      }
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        this.logger.warn(
          `Glovo ${method} ${path} → ${lastError} — retrying in ${delay}ms ` +
            `(attempt ${attempt}/${maxAttempts})`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    this.logger.warn(`Glovo ${method} ${path} failed: ${lastError}`);
    throw new GlovoApiError(
      lastStatus,
      lastText,
      `Glovo ${method} ${path} → ${lastError}`,
    );
  }
}
