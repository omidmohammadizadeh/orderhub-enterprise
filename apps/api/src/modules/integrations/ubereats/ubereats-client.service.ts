import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

// Phase UE-1 — Uber Eats direct integration, foundation layer.
//
// Uber uses OAuth2 with two grant types:
//   • client_credentials — machine-to-machine, scoped (eats.store, eats.order,
//     eats.report). Per the Store API spec, store status ops use eats.store —
//     there is no eats.store.status.write scope. Tokens live 30 days; token
//     requests are rate-limited to 100/hour, so we cache per scope-set and
//     only re-fetch in the final hour of validity.
//   • authorization_code — merchant-facing (eats.pos_provisioning) for store
//     discovery + provisioning; handled by UberEatsOauthService.
//
// Verified against developer.uber.com (authentication + webhooks guides) and
// the partner-provided OpenAPI specs (servers: https://api.uber.com):
//   Token:   POST https://auth.uber.com/oauth/v2/token  x-www-form-urlencoded
//   API:     Authorization: Bearer <token>
//   Webhook: X-Uber-Signature = lowercase hex HMAC-SHA256(rawBody) keyed with
//            the CLIENT SECRET (Uber signs with the client secret, not a
//            separate webhook key — we accept either, some portals issue a
//            dedicated signing key).

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

@Injectable()
export class UberEatsClientService {
  private readonly logger = new Logger(UberEatsClientService.name);
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService) {}

  private cfg(key: string): string {
    return this.config.get<string>(`app.platforms.uberEats.${key}`) ?? "";
  }

  /** True when the platform-level Uber Eats app credentials are set. */
  get configured(): boolean {
    return !!this.cfg("clientId") && !!this.cfg("clientSecret");
  }

  get clientId(): string {
    return this.cfg("clientId");
  }

  /** API host — the new marketplace surface lives at the bare host
   *  (…/v1/delivery/…, /v2/eats/…), NOT the legacy /v2 base. */
  get apiBase(): string {
    return this.cfg("apiBase") || "https://api.uber.com";
  }

  get authBase(): string {
    return this.cfg("authUrl") || "https://auth.uber.com/oauth/v2";
  }

  /**
   * OAuth2 client-credentials token for a scope set. Uber tokens are valid
   * for 30 days and token minting is rate-limited (100/hour) — cache per
   * scope-set until 1 hour before expiry.
   */
  async getToken(scopes: string[]): Promise<string> {
    const key = [...scopes].sort().join(" ");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - 3_600_000 > now) return hit.token;

    const clientId = this.cfg("clientId");
    const clientSecret = this.cfg("clientSecret");
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        "Uber Eats isn't configured on the server (missing client credentials).",
      );
    }
    const res = await fetch(`${this.authBase}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: key,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BadRequestException(
        `Uber Eats auth failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    const json = JSON.parse(text) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    this.cache.set(key, {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 2_592_000) * 1000,
    });
    // Uber SILENTLY DROPS scopes the app isn't whitelisted for (no
    // invalid_scope error) — the endpoint then 401s later. Compare what we
    // asked for against what was actually granted so the gap is visible at
    // mint time, not at the first failing store call.
    const granted = (json.scope ?? "").split(/\s+/).filter(Boolean);
    this.lastGrantedScopes.set(key, granted);
    const missing = scopes.filter((s) => !granted.includes(s));
    if (json.scope !== undefined && missing.length > 0) {
      this.logger.warn(
        `Uber Eats token for [${key}] was granted WITHOUT [${missing.join(", ")}] — the app isn't whitelisted for those scopes (enable them in the Uber developer dashboard / ask Uber). Granted: [${granted.join(", ") || "none"}]`,
      );
    } else {
      this.logger.log(
        `Uber Eats token minted for scopes [${key}] granted=[${granted.join(", ") || "?"}] (expires_in=${json.expires_in ?? "?"}s)`,
      );
    }
    return json.access_token;
  }

  /** requested-scope-set → scopes Uber actually granted (diagnostics). */
  private readonly lastGrantedScopes = new Map<string, string[]>();

  /**
   * Mint (or reuse) a token for each scope and report what Uber actually
   * granted — the definitive check for which scopes the app is whitelisted
   * for, since Uber drops unapproved scopes silently.
   */
  async probeScopes(scopes: string[]): Promise<
    Array<{ scope: string; granted: boolean | "unknown"; error?: string }>
  > {
    const out: Array<{ scope: string; granted: boolean | "unknown"; error?: string }> = [];
    for (const scope of scopes) {
      try {
        await this.getToken([scope]);
        const granted = this.lastGrantedScopes.get(scope);
        out.push({
          scope,
          granted: granted ? granted.includes(scope) : "unknown",
        });
      } catch (err: any) {
        out.push({
          scope,
          granted: false,
          error: String(err?.message ?? err).slice(0, 200),
        });
      }
    }
    return out;
  }

  /**
   * Exchange an authorization code for a merchant (user) token —
   * eats.pos_provisioning flow. Returns the raw token response.
   */
  async exchangeAuthorizationCode(code: string, redirectUri: string) {
    const res = await fetch(`${this.authBase}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.cfg("clientId"),
        client_secret: this.cfg("clientSecret"),
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BadRequestException(
        `Uber Eats code exchange failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    return JSON.parse(text) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }

  /**
   * Authenticated request against api.uber.com. `path` starts with "/".
   * Pass `scopes` for a client-credentials call, or `userToken` to call
   * merchant-scoped endpoints (store list / pos_data). Returns parsed JSON
   * (null for empty 2xx bodies like the menu upsert's 204).
   */
  async request<T = any>(
    method: string,
    path: string,
    opts: {
      scopes?: string[];
      userToken?: string;
      body?: unknown;
      /** Out-param: request() writes Uber's HTTP status here so callers can
       *  surface the acknowledgment ("200 OK") in the activity log. */
      meta?: { status?: number };
    } = {},
  ): Promise<T> {
    const token = opts.userToken ?? (await this.getToken(opts.scopes ?? []));
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    if (opts.meta) opts.meta.status = res.status;
    if (!res.ok) {
      this.logger.warn(
        `Uber Eats ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
      throw new BadRequestException(
        `Uber Eats ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    // Log successes too — a silent 2xx on a wrong-shaped body cost us a
    // debugging round on Deliveroo opening hours; keep the same discipline.
    this.logger.log(`Uber Eats ${method} ${path} → ${res.status}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Verify an inbound webhook: X-Uber-Signature is the lowercased hex
   * HMAC-SHA256 of the raw body, keyed with the client secret (per Uber's
   * webhook security docs). Some Uber apps also surface a dedicated signing
   * key — if UBER_EATS_WEBHOOK_SECRET is set we accept a match on either.
   * Never throws; raw bytes only, no re-serialisation.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): boolean {
    if (!signature) return false;
    const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
    const keys = [this.cfg("clientSecret"), this.cfg("webhookSecret")].filter(
      Boolean,
    );
    const received = signature.trim().toLowerCase();
    for (const key of keys) {
      const expected = crypto
        .createHmac("sha256", key)
        .update(body)
        .digest("hex");
      try {
        if (
          expected.length === received.length &&
          crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
        ) {
          return true;
        }
      } catch {
        /* length mismatch → keep trying */
      }
    }
    return false;
  }

  /** Which secrets are configured — for actionable webhook-rejection logs. */
  signatureDiagnostics(): { clientSecretSet: boolean; webhookSecretSet: boolean } {
    return {
      clientSecretSet: !!this.cfg("clientSecret"),
      webhookSecretSet: !!this.cfg("webhookSecret"),
    };
  }
}
