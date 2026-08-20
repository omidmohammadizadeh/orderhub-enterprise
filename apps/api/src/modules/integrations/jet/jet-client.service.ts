import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import {
  JetCredentialResolver,
  type JetKeyType,
} from "./jet-credential.resolver";

// Phase JE-0 — JET Connect transport + inbound authentication.
//
// VERIFIED, not assumed. The spec documents the order-webhook signature as:
//
//   X-JET-Connect-Hash: HMAC-SHA256 t=1673428038618,signature=gy7ev…8lI=
//
// and gives a worked example: secret "key", body "example" produces
// "FGwot7AqiDIthEv6TippJm35DaRpRac5NSLd/wSp9go=". Running that example
// confirms the signed input is the RAW BODY ALONE — base64(HMAC-SHA256(secret,
// body)). The `t` timestamp rides in the same header but is NOT part of the
// signed material, which is easy to get backwards (Stripe, Deliveroo and Uber
// all fold a timestamp in). verifyWebhookSignature implements exactly the
// verified scheme; diagnoseSignatureVariant tries the others so that when a
// real webhook fails we learn whether the SECRET is wrong or the FORMAT is,
// instead of guessing. That diagnostic is the single thing that turned a
// day-long Deliveroo signature hunt into one log line.
//
// Outbound calls carry `X-Flyt-Api-Key` (JET Connect was formerly Flyt) and
// go to one of three hosts depending on the operation — see JetHost.

/** Which JET service host an operation lives on. */
export type JetHost = "platform" | "orderStatus" | "orderingConnector";

export interface JetRequestOptions {
  /** Which key tier to resolve. Menu key vs order key are different keys. */
  keyType: JetKeyType;
  brandId?: string | null;
  locationId?: string | null;
  country?: string | null;
  host?: JetHost;
  body?: unknown;
  /**
   * Retries on 429 / 5xx / network error. Defaults to 0 (fail fast) — set it
   * on calls where success is contractual, above all the order acks.
   */
  retries?: number;
  /** Base delay between retries in ms; doubles each attempt. */
  retryDelayMs?: number;
}

export interface JetSignatureHeader {
  timestampMs: number | null;
  signature: string | null;
}

/**
 * Split `HMAC-SHA256 t=<ms>,signature=<base64>` into its parts.
 *
 * Tolerant by design: the algorithm prefix, the ordering of the pairs and the
 * spacing around them are all things a sender can reasonably vary, and none of
 * them affect what we verify. Returns nulls rather than throwing so the caller
 * can log a malformed header and reject cleanly.
 */
export function parseJetSignatureHeader(
  raw: string | undefined,
): JetSignatureHeader {
  if (!raw) return { timestampMs: null, signature: null };
  // Drop a leading algorithm token ("HMAC-SHA256") if present.
  const withoutAlg = raw.replace(/^\s*HMAC-SHA256\s+/i, "").trim();
  let timestampMs: number | null = null;
  let signature: string | null = null;
  for (const part of withoutAlg.split(",")) {
    const [rawKey, ...rest] = part.split("=");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    // Re-join on "=" — base64 signatures are padded with it.
    const value = rest.join("=").trim();
    if (key === "t") {
      const n = Number(value);
      timestampMs = Number.isFinite(n) ? n : null;
    } else if (key === "signature" || key === "s") {
      signature = value || null;
    }
  }
  // A bare signature with no key=value structure at all.
  if (!signature && !withoutAlg.includes("=") && withoutAlg) {
    signature = withoutAlg;
  }
  return { timestampMs, signature };
}

@Injectable()
export class JetClientService {
  private readonly logger = new Logger(JetClientService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: JetCredentialResolver,
  ) {}

  private cfg(key: string): string {
    return this.config.get<string>(`app.platforms.jet.${key}`) ?? "";
  }

  /** True when we can both authenticate JET's calls and make our own. */
  get configured(): boolean {
    return (
      this.credentials.configured("menu") || this.credentials.configured("order")
    );
  }

  private hostUrl(host: JetHost = "platform"): string {
    const raw =
      host === "orderStatus"
        ? this.cfg("orderStatusUrl")
        : host === "orderingConnector"
          ? this.cfg("orderingConnectorUrl")
          : this.cfg("baseUrl");
    return (raw || "https://api.flytplatform.com").replace(/\/+$/, "");
  }

  // ── Inbound authentication ───────────────────────────────────────────

  /**
   * Verify the `X-JET-Connect-Hash` HMAC over the raw request bytes.
   *
   * `rawBody` MUST be the bytes exactly as received. Re-serialising the parsed
   * JSON changes key order and whitespace and will never match.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    header: string | undefined,
  ): boolean {
    const secret = this.cfg("webhookSecret");
    const { signature } = parseJetSignatureHeader(header);
    if (!secret || !signature) return false;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
      .digest("base64");
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      // timingSafeEqual throws on a length mismatch, which is itself a
      // (harmless) reject — the lengths are fixed for a given algorithm.
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** True when a webhook secret is configured at all. */
  get webhookSecretConfigured(): boolean {
    return !!this.cfg("webhookSecret");
  }

  /**
   * Which signing scheme — if any — reproduces JET's signature with the
   * secret we have deployed.
   *
   * Purely diagnostic, never used for authentication. A NAMED match means the
   * secret is right and only our signing format is off (a code fix); a
   * "no_match" means the secret VALUE is wrong (an env fix). Distinguishing
   * those two without a probe costs a deploy cycle per guess.
   */
  diagnoseSignatureVariant(
    rawBody: Buffer | string,
    header: string | undefined,
  ): string {
    const secret = this.cfg("webhookSecret");
    if (!secret) return "no_secret";
    const { signature, timestampMs } = parseJetSignatureHeader(header);
    if (!signature) return "no_signature";
    const body =
      typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
    const t = String(timestampMs ?? "");
    const B = (s: string) => Buffer.from(s);
    const hmac = (parts: Buffer[], enc: "base64" | "hex"): string => {
      const h = crypto.createHmac("sha256", secret);
      for (const p of parts) h.update(p);
      return h.digest(enc);
    };
    const variants: Record<string, Buffer[]> = {
      // The documented + example-verified scheme.
      body_only: [body],
      // Timestamp-folded schemes, in the shapes other platforms use.
      "t.body": [B(t), B("."), body],
      "t+body": [B(t), body],
      "t:body": [B(t), B(":"), body],
      "body+t": [body, B(t)],
    };
    for (const enc of ["base64", "hex"] as const) {
      for (const [name, parts] of Object.entries(variants)) {
        if (hmac(parts, enc) === signature) {
          return enc === "base64" ? name : `${name}(hex)`;
        }
      }
    }
    return "no_match";
  }

  /**
   * Verify the `Authorization` header JET presents on inbound calls — the API
   * key WE issued to them.
   *
   * This is the ONLY authentication on the four lifecycle webhooks (cancel,
   * driver status, temp-offline, failed-order): they carry no HMAC. When no
   * inbound key is configured we return true, because rejecting every webhook
   * on a fresh deploy would silently drop live orders; the receiver logs the
   * unauthenticated state loudly instead.
   */
  verifyInboundApiKey(header: string | undefined): boolean {
    const expected = this.cfg("inboundApiKey");
    if (!expected) return true;
    const presented = (header ?? "").replace(/^\s*Bearer\s+/i, "").trim();
    if (!presented) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** True when an inbound API key is configured (i.e. we actually check it). */
  get inboundApiKeyConfigured(): boolean {
    return !!this.cfg("inboundApiKey");
  }

  // ── Outbound calls ───────────────────────────────────────────────────

  /**
   * Authenticated request against JET. `path` starts with "/".
   *
   * Returns the parsed JSON body, or null for an empty 2xx (the acks answer
   * 204 and the menu/availability endpoints answer 202).
   */
  async request<T = any>(
    method: string,
    path: string,
    opts: JetRequestOptions,
  ): Promise<T> {
    const { key, source } = await this.credentials.resolve({
      type: opts.keyType,
      brandId: opts.brandId,
      locationId: opts.locationId,
      country: opts.country,
    });
    if (!key) {
      throw new BadRequestException(
        `Just Eat isn't configured on the server: no ${opts.keyType} API key ` +
          `could be resolved (set JET_${opts.keyType.toUpperCase()}_API_KEY, a ` +
          `country key in JET_${opts.keyType.toUpperCase()}_KEYS, or a brand key on the connection).`,
      );
    }

    const url = `${this.hostUrl(opts.host)}${path}`;
    const call = () =>
      fetch(url, {
        method,
        headers: {
          "X-Flyt-Api-Key": key,
          Accept: "application/json",
          ...(opts.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
      });

    const maxAttempts = Math.max(1, (opts.retries ?? 0) + 1);
    const baseDelay = opts.retryDelayMs ?? 500;
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let status = 0;
      let text = "";
      try {
        const res = await call();
        status = res.status;
        text = await res.text();
        if (res.ok) {
          this.logger.log(
            `JET ${method} ${path} → ${status} (key=${opts.keyType}/${source})`,
          );
          return (text ? JSON.parse(text) : null) as T;
        }
        lastError = `${status}: ${text.slice(0, 200)}`;
        // 4xx other than 429 will not get better by asking again.
        if (status < 500 && status !== 429) break;
      } catch (e: any) {
        // Network-level failure — no status at all. Worth a retry.
        lastError = `network: ${e?.message ?? e}`;
      }

      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        this.logger.warn(
          `JET ${method} ${path} → ${lastError} — retrying in ${delay}ms ` +
            `(attempt ${attempt}/${maxAttempts})`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    this.logger.warn(`JET ${method} ${path} failed: ${lastError}`);
    throw new BadRequestException(`JET ${method} ${path} → ${lastError}`);
  }
}
