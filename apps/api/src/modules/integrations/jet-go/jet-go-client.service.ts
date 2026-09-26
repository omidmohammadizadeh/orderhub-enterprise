// Phase BJ — low-level JET Go (Just Eat Takeaway Delivery-as-a-Service) client.
//
// JET Go is Just Eat's last-mile network, exposed through SkipTheDishes' DaaS
// platform, so every hostname below says skipthedishes.com. That is correct and
// not a copy/paste slip.
//
// Auth: Keycloak client-credentials. POST {tokenHost}/auth/realms/daas/protocol/
// openid-connect/token with an HTTP Basic header of base64(clientId:clientSecret)
// and grant_type=client_credentials in the form body. The credentials go in the
// header, NOT the body — unlike Uber Direct.
//
// The token lives FIVE MINUTES (expires_in: 300), which is short enough that a
// cache entry sitting through one slow dispatch can expire mid-call. We refresh
// with 60s to spare and retry once on a 401.
//
// The API and the token live on DIFFERENT hosts: the token comes from
// api-staguk.skipthedishes.com and the delivery calls go to
// api-daas-staguk.skipthedishes.com. Getting this wrong 404s every call.
//
// Docs: https://developers.just-eat.com/documentation/jet-go

import { Injectable, Logger } from "@nestjs/common";

export type JetGoMarket = "UK" | "CA" | "AU" | "EU";

export interface JetGoCreds {
  clientId: string;
  clientSecret: string;
  market: string; // UK | CA | AU | EU
  environment: string; // "sandbox" | "production"
}

/** Per-market host pair. `auth` serves the Keycloak token, `api` the DaaS calls.
 *  Note EU uses a DOT before the environment segment where the others use a
 *  dash (api.stageu1 / api-daas.stageu1) — JET's own table, not a typo here. */
const HOSTS: Record<JetGoMarket, { sandbox: [string, string]; production: [string, string] }> = {
  CA: {
    sandbox: ["api-staging.skipthedishes.com", "api-daas-staging.skipthedishes.com"],
    production: ["api.skipthedishes.com", "api-daas.skipthedishes.com"],
  },
  UK: {
    sandbox: ["api-staguk.skipthedishes.com", "api-daas-staguk.skipthedishes.com"],
    production: ["api-produk.skipthedishes.com", "api-daas-produk.skipthedishes.com"],
  },
  AU: {
    sandbox: ["api-stagaus.skipthedishes.com", "api-daas-stagaus.skipthedishes.com"],
    production: ["api-prodaus.skipthedishes.com", "api-daas-prodaus.skipthedishes.com"],
  },
  EU: {
    sandbox: ["api.stageu1.skipthedishes.com", "api-daas.stageu1.skipthedishes.com"],
    production: ["api.prodeu1.skipthedishes.com", "api-daas.prodeu1.skipthedishes.com"],
  },
};

/** The EU markets where JET requires deliveryDetails, geolocation and
 *  vendorOrderId, and where advance orders / proof-of-pickup / courier location
 *  are NOT supported. The UK is its own market and is deliberately not here. */
export const JET_GO_EU_COUNTRIES = ["BE", "BG", "DK", "DE", "IT", "NL", "PL", "ES", "CH"];

export interface JetGoGeoPoint {
  /** JET's order is [latitude, longitude] — NOT the GeoJSON [lng, lat], even
   *  though `type` says "point". Swapping them silently delivers to the wrong
   *  hemisphere. */
  coordinates: [number, number];
  type: "point";
}

export interface JetGoEstimateBody {
  collect: { id: string };
  delivery: {
    name: string;
    emailAddress: string;
    phoneNumber: string;
    address: string;
    city: string;
    province?: string;
    postalCode?: string;
    geolocation?: JetGoGeoPoint;
  };
  deliveryDetails?: {
    weightGrams?: number;
    /** 5–60. Required for ASAP (no target time), optional when scheduled. */
    preparationDuration?: number;
    hasAlcohol?: boolean;
    ageRestriction?: number;
    ageVerificationWithId?: boolean;
  };
  deliveryOptions?: {
    unreachablePreference?: "DROP_OFF" | "RETURN";
    dropoffAction?: "CONTACTLESS" | "MEET_AT_DOOR";
  };
  /** Advance orders only, 1 hour–5 days out. Never send both. */
  targetDeliverTime?: string;
  targetCollectTime?: string;
}

export interface JetGoEstimateResponse {
  requestId: string;
  /** Courier cost in MINOR units (pence). */
  dynamicDeliveryFee: number;
  dynamicDeliveryFeeRule?: string;
  estimatedEarliestCollectTime?: string | null;
  estimatedEarliestDeliverTime?: string | null;
  targetCollectTime?: string | null;
  targetDeliverTime?: string | null;
}

export interface JetGoDeliveryBody {
  requestId: string;
  specialInstructions?: string;
  targetCollectTime?: string;
  tip?: number;
  orderValue?: number;
  vendorOrderId?: string;
  paymentType?: "PREPAID" | "COD";
  metadata?: Record<string, string>;
}

export interface JetGoCollectPoint {
  id: string;
  name?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  province?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  countryCode?: string;
  shortName?: string;
}

export interface JetGoNotificationConfigBody {
  email: string;
  endpoint: string;
  secret: string;
  type: "BASIC" | "TOKEN";
  username?: string;
  subscriptions?: string[];
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class JetGoClientService {
  private readonly logger = new Logger(JetGoClientService.name);
  private readonly tokenCache = new Map<string, CachedToken>();

  private market(creds: JetGoCreds): JetGoMarket {
    const m = String(creds.market ?? "UK").trim().toUpperCase();
    return (m in HOSTS ? m : "UK") as JetGoMarket;
  }

  private hostPair(creds: JetGoCreds): [string, string] {
    const env = creds.environment === "production" ? "production" : "sandbox";
    return HOSTS[this.market(creds)][env];
  }

  /** Keycloak token host (api-…), which is NOT the DaaS API host. */
  authBase(creds: JetGoCreds): string {
    return `https://${this.hostPair(creds)[0]}`;
  }

  /** DaaS API host (api-daas-…). */
  apiBase(creds: JetGoCreds): string {
    return `https://${this.hostPair(creds)[1]}`;
  }

  /** Cloudflare blocks production requests with no User-Agent, so this is
   *  mandatory on every call (the value itself is free-form). */
  private userAgent(): string {
    return process.env.JET_GO_USER_AGENT ?? "OrderHub/1.0 (+https://orderhub.solutions)";
  }

  private cacheKey(creds: JetGoCreds): string {
    return `${this.market(creds)}:${creds.environment}:${creds.clientId}`;
  }

  private async getToken(creds: JetGoCreds): Promise<string> {
    const key = this.cacheKey(creds);
    const cached = this.tokenCache.get(key);
    // 60s of headroom on a 300s token — a shorter margin risks the token dying
    // between this check and the request landing.
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

    const basic = Buffer.from(
      `${creds.clientId}:${creds.clientSecret}`,
      "utf8",
    ).toString("base64");
    const url = `${this.authBase(creds)}/auth/realms/daas/protocol/openid-connect/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
        "User-Agent": this.userAgent(),
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `JET Go auth failed (${res.status}). Check the Client ID/Secret and that the market is right — ` +
          `${this.market(creds)} credentials only work against the ${this.market(creds)} host. ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    if (!json?.access_token) throw new Error("JET Go auth returned no access_token.");
    this.tokenCache.set(key, {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
    });
    return json.access_token;
  }

  /** Drop the cached token — used by the config screen so a credential change
   *  takes effect immediately instead of after the old token expires. */
  forgetToken(creds: JetGoCreds): void {
    this.tokenCache.delete(this.cacheKey(creds));
  }

  private async request<T = any>(
    creds: JetGoCreds,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.getToken(creds);
    const res = await fetch(`${this.apiBase(creds)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": this.userAgent(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retryOn401) {
      this.forgetToken(creds);
      return this.request<T>(creds, method, path, body, false);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      // JET's error envelope is { error, message, type }.
      const msg = json?.message || json?.error_description || json?.error || text.slice(0, 300);
      const err = new Error(`JET Go ${method} ${path} → ${res.status}: ${msg}`);
      (err as any).status = res.status;
      (err as any).body = json;
      (err as any).jetType = json?.type ?? null;
      throw err;
    }
    return json as T;
  }

  /** GET /v1/delivery/collect-points — the locations JET has onboarded for this
   *  credential. One of these ids is what `collect.id` must be. */
  async collectPoints(
    creds: JetGoCreds,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<JetGoCollectPoint[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const json = await this.request<{ collectPoints?: JetGoCollectPoint[] }>(
      creds,
      "GET",
      `/v1/delivery/collect-points?limit=${limit}&offset=${offset}`,
    );
    return Array.isArray(json?.collectPoints) ? json.collectPoints : [];
  }

  /** POST /v1/delivery/estimate — availability + price, and the requestId that
   *  every later call keys off. The id expires after FIVE MINUTES and is
   *  single-use once a delivery has been created from it. */
  async estimate(creds: JetGoCreds, body: JetGoEstimateBody): Promise<JetGoEstimateResponse> {
    return this.request<JetGoEstimateResponse>(creds, "POST", "/v1/delivery/estimate", body);
  }

  /** POST /v1/delivery — book the courier against an estimate's requestId.
   *  Returns 202: JET has ACCEPTED the request, not created the delivery. The
   *  DELIVERYCREATED webhook is the confirmation. */
  async createDelivery(creds: JetGoCreds, body: JetGoDeliveryBody): Promise<any> {
    return this.request(creds, "POST", "/v1/delivery", body);
  }

  /** PUT /v1/delivery/cancellation-request — allowed until the courier collects.
   *  Returns "being processed"; the CANCELJOBSTATUS webhook says whether it
   *  actually worked. */
  async cancelDelivery(creds: JetGoCreds, requestId: string): Promise<any> {
    return this.request(creds, "PUT", "/v1/delivery/cancellation-request", { requestId });
  }

  /** GET /v1/delivery/status/:requestId — poll fallback for a missed webhook. */
  async deliveryStatus(creds: JetGoCreds, requestId: string): Promise<any> {
    return this.request(creds, "GET", `/v1/delivery/status/${encodeURIComponent(requestId)}`);
  }

  /** POST /v1/delivery/simulate — staging only. Walks a test delivery through
   *  the real webhook sequence so an integration can be proved end to end. */
  async simulate(
    creds: JetGoCreds,
    body: { requestId: string; deliveryStep?: string; stepWaitDuration?: number },
  ): Promise<any> {
    return this.request(creds, "POST", "/v1/delivery/simulate", body);
  }

  /** POST /v1/delivery/notification-config — register our webhook. JET keeps ONE
   *  config per client credential, so posting again replaces the previous one. */
  async createNotificationConfig(
    creds: JetGoCreds,
    body: JetGoNotificationConfigBody,
  ): Promise<any> {
    return this.request(creds, "POST", "/v1/delivery/notification-config", body);
  }

  /** GET /v1/delivery/notification-config — what JET currently has on file. */
  async getNotificationConfig(creds: JetGoCreds): Promise<any> {
    return this.request(creds, "GET", "/v1/delivery/notification-config");
  }

  /** DELETE /v1/delivery/notification-config. */
  async deleteNotificationConfig(creds: JetGoCreds): Promise<any> {
    return this.request(creds, "DELETE", "/v1/delivery/notification-config");
  }
}
