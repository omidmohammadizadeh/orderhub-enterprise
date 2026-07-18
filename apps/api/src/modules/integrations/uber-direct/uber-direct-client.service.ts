// Phase BI — low-level Uber Direct (DaaS) API client.
//
// Auth: OAuth2 client-credentials → POST {auth}/oauth/v2/token with
// grant_type=client_credentials & scope=eats.deliveries → a bearer token
// (~30-day TTL). Cached in-memory per clientId+env, refreshed on expiry/401.
// customer_id lives in the API URL path (unlike Stuart).
//
// Docs: https://developer.uber.com/docs/deliveries

import { Injectable, Logger } from "@nestjs/common";

export interface UberDirectCreds {
  customerId: string;
  clientId: string;
  clientSecret: string;
  environment: string; // "sandbox" | "production"
}

export interface UberDirectQuoteBody {
  pickup_address: string;
  dropoff_address: string;
  pickup_phone_number?: string;
  dropoff_phone_number?: string;
  pickup_latitude?: number;
  pickup_longitude?: number;
  dropoff_latitude?: number;
  dropoff_longitude?: number;
}

export interface UberDirectDeliveryBody {
  quote_id?: string;
  pickup_name: string;
  pickup_address: string;
  pickup_phone_number: string;
  pickup_business_name?: string;
  dropoff_name: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  dropoff_notes?: string;
  manifest_total_value?: number; // minor units (pence)
  manifest_items: Array<{
    name: string;
    quantity: number;
    size?: string; // small | medium | large | xlarge
  }>;
  external_id?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class UberDirectClientService {
  private readonly logger = new Logger(UberDirectClientService.name);
  private readonly tokenCache = new Map<string, CachedToken>();

  // Uber's OAuth token host. Overridable if Uber moves it (auth. vs login.).
  private authTokenUrl(): string {
    return (
      process.env.UBER_DIRECT_AUTH_URL ?? "https://auth.uber.com/oauth/v2/token"
    );
  }

  // Uber Direct REST base. Same host for sandbox + production; the account's
  // Test-mode credentials route to the sandbox server-side.
  private apiBase(): string {
    return process.env.UBER_DIRECT_API_BASE ?? "https://api.uber.com";
  }

  private async getToken(creds: UberDirectCreds): Promise<string> {
    const key = `${creds.environment}:${creds.clientId}`;
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 120_000) return cached.token;

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "client_credentials",
      scope: "eats.deliveries",
    });
    const res = await fetch(this.authTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Uber Direct auth failed (${res.status}). Check the client ID/secret. ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    const ttlMs = (json.expires_in ?? 2_592_000) * 1000;
    this.tokenCache.set(key, {
      token: json.access_token,
      expiresAt: Date.now() + ttlMs,
    });
    return json.access_token;
  }

  private async request<T = any>(
    creds: UberDirectCreds,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.getToken(creds);
    const res = await fetch(`${this.apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retryOn401) {
      this.tokenCache.delete(`${creds.environment}:${creds.clientId}`);
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
      const msg =
        json?.message || json?.error || json?.code || text.slice(0, 300);
      const err = new Error(`Uber Direct ${method} ${path} → ${res.status}: ${msg}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }
    return json as T;
  }

  /** POST /v1/customers/:cid/delivery_quotes — price + ETA. */
  async quote(creds: UberDirectCreds, body: UberDirectQuoteBody): Promise<any> {
    return this.request(
      creds,
      "POST",
      `/v1/customers/${creds.customerId}/delivery_quotes`,
      body,
    );
  }

  /** POST /v1/customers/:cid/deliveries — create the delivery. */
  async createDelivery(
    creds: UberDirectCreds,
    body: UberDirectDeliveryBody,
  ): Promise<any> {
    return this.request(
      creds,
      "POST",
      `/v1/customers/${creds.customerId}/deliveries`,
      body,
    );
  }

  /** GET /v1/customers/:cid/deliveries/:id. */
  async getDelivery(creds: UberDirectCreds, deliveryId: string): Promise<any> {
    return this.request(
      creds,
      "GET",
      `/v1/customers/${creds.customerId}/deliveries/${deliveryId}`,
    );
  }

  /** POST /v1/customers/:cid/deliveries/:id/cancel. */
  async cancelDelivery(creds: UberDirectCreds, deliveryId: string): Promise<any> {
    return this.request(
      creds,
      "POST",
      `/v1/customers/${creds.customerId}/deliveries/${deliveryId}/cancel`,
    );
  }
}
