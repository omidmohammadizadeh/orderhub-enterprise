import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

// Phase BA — Deliveroo direct integration, foundation layer.
//
// Deliveroo uses OAuth2 client-credentials (machine-to-machine): we exchange
// the platform's DELIVEROO_CLIENT_ID/SECRET for a short-lived Bearer token and
// cache it in-memory until ~30s before expiry. Every API call goes through
// request(); inbound webhooks are verified with verifyWebhookSignature().
//
// Verified against Deliveroo docs (auth + securing-webhooks) and the existing
// live integration audit:
//   Token:   POST {authUrl}  x-www-form-urlencoded  grant_type=client_credentials
//   API:     Authorization: Bearer <token>   base {baseUrl}
//   Webhook: HMAC-SHA256(secret, `${sequenceGuid} ${rawBody}`) hex
//            (legacy new_order/cancel_order use `${sequenceGuid} \n ${rawBody}`)

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

@Injectable()
export class DeliverooClientService {
  private readonly logger = new Logger(DeliverooClientService.name);
  private cached: CachedToken | null = null;

  constructor(private readonly config: ConfigService) {}

  private cfg(key: string): string {
    return this.config.get<string>(`app.platforms.deliveroo.${key}`) ?? "";
  }

  /** True when the platform-level Deliveroo app credentials are set. */
  get configured(): boolean {
    return !!this.cfg("clientId") && !!this.cfg("clientSecret");
  }

  private get baseUrl(): string {
    return this.cfg("baseUrl") || "https://api.developers.deliveroo.com";
  }

  private get authUrl(): string {
    return (
      this.cfg("authUrl") || "https://auth.developers.deliveroo.com/oauth2/token"
    );
  }

  /** OAuth2 client-credentials token, cached until ~30s before it expires. */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 30_000 > now) {
      return this.cached.token;
    }
    const clientId = this.cfg("clientId");
    const clientSecret = this.cfg("clientSecret");
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        "Deliveroo isn't configured on the server (missing client credentials).",
      );
    }
    const res = await fetch(this.authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BadRequestException(
        `Deliveroo auth failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    const json = JSON.parse(text) as {
      access_token: string;
      expires_in?: number;
    };
    this.cached = {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 300) * 1000,
    };
    return json.access_token;
  }

  /**
   * Authenticated request against the Deliveroo API. `path` starts with "/".
   * Returns the parsed JSON body (null for empty 2xx responses like 204).
   */
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(
        `Deliveroo ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
      throw new BadRequestException(
        `Deliveroo ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    // Log the successful call too — silent 2xx made a wrong-shaped
    // opening_hours body look like a working publish (see BA-2 fix).
    this.logger.log(`Deliveroo ${method} ${path} → ${res.status}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Verify an inbound Deliveroo webhook signature. `rawBody` MUST be the raw
   * bytes exactly as received (no JSON re-serialisation). Returns true only on
   * a valid HMAC. Never throws — a bad signature is a boolean, so the caller
   * can log + 200 without leaking timing.
   */
  /**
   * Diagnostics for a failed webhook verification — lets the receiver log
   * WHY it failed (secret missing vs the deployed secret not matching
   * Deliveroo's). Returns the two expected HMACs (both separators) so a
   * mismatch is visible without leaking the secret itself.
   */
  signatureDiagnostics(
    sequenceGuid: string,
    rawBody: Buffer | string,
  ): {
    configured: boolean;
    expectedStandard: string | null;
    expectedLegacy: string | null;
  } {
    const secret = this.cfg("webhookSecret");
    if (!secret) {
      return { configured: false, expectedStandard: null, expectedLegacy: null };
    }
    const buf =
      typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
    const sign = (sep: string) => {
      const h = crypto.createHmac("sha256", secret);
      h.update(sequenceGuid);
      h.update(sep);
      h.update(buf);
      return h.digest("hex");
    };
    return {
      configured: true,
      expectedStandard: sign(" "),
      expectedLegacy: sign(" \n "),
    };
  }

  verifyWebhookSignature(
    sequenceGuid: string,
    rawBody: Buffer | string,
    signature: string | undefined,
    legacy = false,
  ): boolean {
    const secret = this.cfg("webhookSecret");
    if (!secret || !signature || !sequenceGuid) return false;
    const h = crypto.createHmac("sha256", secret);
    h.update(sequenceGuid);
    h.update(legacy ? " \n " : " ");
    h.update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody);
    const expected = h.digest("hex");
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
      );
    } catch {
      return false;
    }
  }
}
