import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { kInt, parseKeetaJson, stringifyKeeta } from "./keeta-json";
import { keetaSign } from "./keeta-signature";

// Phase KT-0 — transport for the Standard Keeta API (Gulf + Hong Kong).
//
// ── Which Keeta API this is ─────────────────────────────────────────────────
//
// Keeta's docs site documents THREE API families on the same host. This is
// the "Standard Keeta API" (https://open.mykeeta.com/api/open): the one whose
// currencies are AED/SAR/KWD/QAR/BHD/OMR and whose languages are en/ar. The
// "Open Delivery" pages — the site's default — are the BRAZILIAN standard
// (Portuguese UI, BRL, HMAC in an X-App-Signature header) and are NOT this.
// Nobody at Keeta has confirmed the mapping in writing yet; it is inferred
// from the currencies, languages and examples. See docs/keeta-integration.md.
//
// ── Protocol ────────────────────────────────────────────────────────────────
//
//   • Every call is a POST with a JSON body. Parameters go in the body, never
//     the query string (image upload is the one exception, not used here).
//   • Every body carries appId, accessToken, timestamp (Unix SECONDS) and sig.
//     The per-endpoint OpenAPI schemas omit all four — add them regardless.
//   • HTTP is 200 for anything Keeta received. Success is `code: 0` in the
//     body; any other code is a failure, with the reason in `message`.
//   • Error code bands: 1150001xx signature/token, 1150002xx–3xx bad params,
//     3150001xx Keeta's own fault.
//
// ── Environments ────────────────────────────────────────────────────────────
//
// There is NO separate sandbox host. Test and production are different
// APPLICATIONS (a test appId/secret during development, a production pair
// issued after the joint SIT) against test stores or real ones. KEETA_ENV
// only decides which webhook set we register ("Test Store" vs "Formal Store").

export type KeetaEnv = "test" | "production";

export const KEETA_DEFAULT_BASE = "https://open.mykeeta.com/api/open";

/** A Keeta call that came back with a non-zero `code`. */
export class KeetaApiError extends BadRequestException {
  constructor(
    readonly keetaCode: number | string,
    readonly keetaMessage: string,
    readonly path: string,
    readonly data?: unknown,
    readonly errorList?: unknown,
  ) {
    super(`Keeta ${path} failed (${keetaCode}): ${keetaMessage}`);
  }

  /** 1150001xx — the sig or the token was rejected. */
  get isAuthError(): boolean {
    const c = Number(this.keetaCode);
    return c >= 115000100 && c <= 115000199;
  }

  /** 3150001xx — Keeta's own server failed; worth a retry. */
  get isServerError(): boolean {
    const c = Number(this.keetaCode);
    return c >= 315000100 && c <= 315000199;
  }
}

export interface KeetaEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
  errorList?: unknown[];
}

export interface KeetaRequestOptions {
  /** The merchant's OAuth access token. Omitted only for /base/oauth/token
   *  and /base/callback/url/set, which are signed by the app alone. */
  accessToken?: string | null;
  /** Retries on network error / 5xx / Keeta server-error codes. Default 0. */
  retries?: number;
  timeoutMs?: number;
}

@Injectable()
export class KeetaClientService {
  private readonly logger = new Logger(KeetaClientService.name);

  get appId(): string {
    return (process.env.KEETA_APP_ID ?? "").trim();
  }

  private get appSecret(): string {
    return (process.env.KEETA_APP_SECRET ?? "").trim();
  }

  /** Both halves of the app credential are present. */
  get configured(): boolean {
    return /^\d+$/.test(this.appId) && !!this.appSecret;
  }

  get baseUrl(): string {
    return (process.env.KEETA_API_BASE ?? KEETA_DEFAULT_BASE).replace(/\/+$/, "");
  }

  get env(): KeetaEnv {
    return process.env.KEETA_ENV === "production" ? "production" : "test";
  }

  /** For webhook verification, which needs the secret but must not export it. */
  webhookSecret(): string {
    return this.appSecret;
  }

  /** Where Keeta should send the merchant's browser after authorizing. */
  get oauthRedirectUri(): string {
    const explicit = (process.env.KEETA_OAUTH_REDIRECT_URI ?? "").trim();
    if (explicit) return explicit;
    // Our own callback. The SAME value must be entered on the Keeta app's
    // "Push Oauth2 authorization code" setting, or Keeta refuse the redirect.
    const api = (process.env.API_URL ?? "").trim().replace(/\/+$/, "");
    return api && !api.includes("localhost") ? `${api}/api/v1/integrations/keeta/oauth/callback` : "";
  }

  /**
   * The link a merchant opens to authorize us.
   *
   * `state` is ours and comes back unchanged — on the redirect AND in the
   * event-1 webhook — which is how an authorization finds its way back to the
   * tenant that started it. Keeta require the same redirectUri to be set on
   * the app's "Push Oauth2 authorization code" setting.
   */
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      responseType: "authorization_code",
      appId: this.appId,
      redirectUri: this.oauthRedirectUri,
      state,
      scope: "all",
    });
    return `https://merchant.mykeeta.com/m/web/openapi/authorize?${q.toString()}`;
  }

  /**
   * Call a Standard API endpoint.
   *
   * `path` is relative to the base, e.g. "/order/confirm". The four common
   * fields are added here, signed, and the envelope unwrapped: a non-zero
   * `code` throws KeetaApiError, so callers only ever see `data`.
   */
  async request<T = unknown>(
    path: string,
    fields: Record<string, unknown>,
    opts: KeetaRequestOptions = {},
  ): Promise<T> {
    const full = await this.requestEnvelope<T>(path, fields, opts);
    return full.data as T;
  }

  /** As request(), but hands back the whole envelope — for the batch
   *  endpoints whose "Partial Failure" still says code 0. */
  async requestEnvelope<T = unknown>(
    path: string,
    fields: Record<string, unknown>,
    opts: KeetaRequestOptions = {},
  ): Promise<KeetaEnvelope<T>> {
    if (!this.configured) {
      throw new BadRequestException(
        "Keeta is not configured: set KEETA_APP_ID and KEETA_APP_SECRET (from the Keeta Developer Portal).",
      );
    }
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const retries = Math.max(0, opts.retries ?? 0);
    let attempt = 0;
    for (;;) {
      // Signed per ATTEMPT: the timestamp is part of the signature, and a
      // retry carrying a stale one is how a transient failure becomes a
      // signature failure.
      const body: Record<string, unknown> = {
        ...fields,
        appId: kInt(this.appId),
        ...(opts.accessToken ? { accessToken: opts.accessToken } : {}),
        timestamp: Math.floor(Date.now() / 1000),
      };
      body.sig = keetaSign(url, body, this.appSecret);

      let text = "";
      let status = 0;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              // Not required by Keeta's docs; every other Gulf API we use sits
              // behind a WAF that drops requests without one.
              "User-Agent": "OrderHub/1.0 (+https://orderhubsolutions.com)",
            },
            body: stringifyKeeta(body),
            signal: ctrl.signal,
          });
          status = res.status;
          text = await res.text();
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        if (attempt < retries) {
          attempt++;
          await sleep(500 * attempt);
          continue;
        }
        throw new BadRequestException(`Keeta ${path} unreachable: ${err?.message ?? err}`);
      }

      if (status >= 500 && attempt < retries) {
        attempt++;
        await sleep(500 * attempt);
        continue;
      }

      let env: KeetaEnvelope<T>;
      try {
        env = parseKeetaJson<KeetaEnvelope<T>>(text);
      } catch {
        throw new BadRequestException(
          `Keeta ${path} answered HTTP ${status} with a non-JSON body: ${text.slice(0, 300)}`,
        );
      }
      if (Number(env?.code) === 0) return env;

      const error = new KeetaApiError(
        env?.code ?? `HTTP ${status}`,
        String(env?.message ?? "no message"),
        path,
        env?.data,
        env?.errorList,
      );
      if (error.isServerError && attempt < retries) {
        attempt++;
        await sleep(500 * attempt);
        continue;
      }
      // The body is logged in full: Keeta's messages are the only diagnosis a
      // failed SIT case gets, and a swallowed one is a lost afternoon.
      this.logger.warn(`Keeta ${path} → code ${env?.code}: ${env?.message} ${text.slice(0, 1000)}`);
      throw error;
    }
  }

  // ── OAuth ───────────────────────────────────────────────────────────────

  /** Exchange an authorization code. Codes are single-use and die after 10 minutes. */
  exchangeCode(code: string): Promise<KeetaTokenResponse> {
    return this.request<KeetaTokenResponse>("/base/oauth/token", {
      grantType: "authorization_code",
      code,
    });
  }

  /**
   * Refresh a token pair. The refresh token is SINGLE-USE: the moment this
   * succeeds the old one is dead, so the caller must persist the new pair
   * before doing anything else. The old ACCESS token lingers for 60 minutes.
   */
  refreshToken(refreshToken: string): Promise<KeetaTokenResponse> {
    return this.request<KeetaTokenResponse>("/base/oauth/token", {
      grantType: "refresh_token",
      refreshToken,
    });
  }

  /** Which Keeta brand and stores a token covers. */
  async authorizedResources(accessToken: string): Promise<KeetaAuthorizedResources> {
    const shops: KeetaAuthorizedShop[] = [];
    let first: KeetaAuthorizedResources | null = null;
    // Paginated, 200 a page at most. A chain with more stores than one page
    // would otherwise look like it had authorized only its first 200.
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const data = await this.request<KeetaAuthorizedResources>(
        "/base/authorized/resource/get",
        { pageNum, pageSize: 200 },
        { accessToken },
      );
      first ??= data;
      const page = Array.isArray(data?.authorizedShops) ? data.authorizedShops : [];
      shops.push(...page);
      if (page.length < 200) break;
    }
    return { ...(first ?? {}), authorizedShops: shops };
  }

  /**
   * Register one webhook URL for one event, on the Test or Formal store set.
   * Signed by the app alone — no merchant token.
   */
  setCallbackUrl(eventId: number, url: string, isTest: boolean): Promise<unknown> {
    return this.request("/base/callback/url/set", { eventId, url, isTest: isTest ? 1 : 0 });
  }

  /**
   * Decrypt customer PII (values prefixed "ENC_").
   *
   * Keeta only allow this for orders the MERCHANT delivers (or a 3PL does) —
   * for a Keeta-rider order the call is refused, by design: the rider has the
   * address, the shop does not need it. At most 50 values per call.
   */
  async batchDecrypt(
    accessToken: string,
    shopId: string,
    cipherTexts: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = Array.from(new Set(cipherTexts.filter((c) => /^ENC_/.test(c))));
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const data = await this.request<{
        plainInfos?: Array<{ cipherText?: string; plainText?: string; errorCode?: number }>;
      }>(
        "/base/batchDecrypt",
        { shopId: kInt(shopId), cipherInfos: chunk.map((cipherText) => ({ cipherText })) },
        { accessToken },
      );
      for (const p of data?.plainInfos ?? []) {
        if (p?.cipherText && p.plainText != null && Number(p.errorCode ?? 0) === 0) {
          out.set(p.cipherText, p.plainText);
        }
      }
    }
    return out;
  }
}

export interface KeetaTokenResponse {
  accessToken: string;
  tokenType?: string;
  /** Seconds. 7 776 000 = 90 days. */
  expiresIn: number;
  refreshToken: string;
  scope?: string;
  /** MILLISECONDS, unlike expiresIn. */
  issuedAtTime?: number;
}

export interface KeetaAuthorizedShop {
  id: number | string;
  name?: string;
  address?: string;
  longitude?: string;
  latitude?: string;
}

export interface KeetaAuthorizedResources {
  userId?: number | string;
  brandId?: number | string;
  brandName?: string;
  authorizedShops?: KeetaAuthorizedShop[];
  page?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
