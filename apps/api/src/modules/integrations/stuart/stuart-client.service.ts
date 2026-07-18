// Phase BH — low-level Stuart API client.
//
// Stuart uses OAuth2 client-credentials: POST {base}/oauth/token with
// grant_type=client_credentials & scope=api → a bearer token (JWT, ~1 month
// TTL). We cache tokens in-memory keyed by clientId+env and refresh on expiry
// or a 401. Everything else is thin passthrough to the v2 Jobs endpoints.
//
// Docs: https://api-docs.stuart.com/  (sandbox: api.sandbox.stuart.com)

import { Injectable, Logger } from "@nestjs/common";

export interface StuartCreds {
  clientId: string;
  clientSecret: string;
  environment: string; // "sandbox" | "production"
}

export interface StuartContact {
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
}

export interface StuartJobPayload {
  job: {
    assignment_code?: string;
    pickups: Array<{
      address: string;
      comment?: string;
      contact?: StuartContact;
    }>;
    dropoffs: Array<{
      package_type?: string; // small | medium | large | xlarge
      package_description?: string;
      client_reference?: string;
      address: string;
      comment?: string;
      contact?: StuartContact;
    }>;
    transport_type?: string[]; // bike | motorbike | cargobike | car | van
  };
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

@Injectable()
export class StuartClientService {
  private readonly logger = new Logger(StuartClientService.name);
  private readonly tokenCache = new Map<string, CachedToken>();

  private baseUrl(env: string): string {
    return env === "production"
      ? "https://api.stuart.com"
      : "https://api.sandbox.stuart.com";
  }

  private async getToken(creds: StuartCreds): Promise<string> {
    const key = `${creds.environment}:${creds.clientId}`;
    const cached = this.tokenCache.get(key);
    // Refresh a couple of minutes early so an in-flight call never races expiry.
    if (cached && cached.expiresAt - Date.now() > 120_000) return cached.token;

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: "api",
      grant_type: "client_credentials",
    });
    const res = await fetch(`${this.baseUrl(creds.environment)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Stuart auth failed (${res.status}). Check the client ID/secret for this location. ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.tokenCache.set(key, {
      token: json.access_token,
      expiresAt: Date.now() + ttlMs,
    });
    return json.access_token;
  }

  private async request<T = any>(
    creds: StuartCreds,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.getToken(creds);
    const res = await fetch(`${this.baseUrl(creds.environment)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retryOn401) {
      // Token likely revoked/expired — drop cache and try once more.
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
        json?.message ||
        json?.error?.message ||
        json?.error ||
        text.slice(0, 300);
      const err = new Error(`Stuart ${method} ${path} → ${res.status}: ${msg}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }
    return json as T;
  }

  /** POST /v2/jobs/pricing — quote a delivery (amount + currency). */
  async pricing(creds: StuartCreds, payload: StuartJobPayload): Promise<any> {
    return this.request(creds, "POST", "/v2/jobs/pricing", payload);
  }

  /** POST /v2/jobs/validate — pre-flight deliverability check. */
  async validate(creds: StuartCreds, payload: StuartJobPayload): Promise<any> {
    return this.request(creds, "POST", "/v2/jobs/validate", payload);
  }

  /** POST /v2/jobs — create the delivery job. */
  async createJob(creds: StuartCreds, payload: StuartJobPayload): Promise<any> {
    return this.request(creds, "POST", "/v2/jobs", payload);
  }

  /** GET /v2/jobs/:id — current job + deliveries state. */
  async getJob(creds: StuartCreds, jobId: string | number): Promise<any> {
    return this.request(creds, "GET", `/v2/jobs/${jobId}`);
  }

  /** POST /v2/jobs/:id/cancel — cancel a job before pickup. */
  async cancelJob(creds: StuartCreds, jobId: string | number): Promise<any> {
    return this.request(creds, "POST", `/v2/jobs/${jobId}/cancel`);
  }
}
