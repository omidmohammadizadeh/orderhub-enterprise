// Thin HTTP client for the Dojo API (https://api.dojo.tech), version
// 2026-02-27. Every call is made with ONE merchant's secret key — Dojo has no
// platform/Connect model: each Dojo location account owns its own keys, its
// own terminals and its own money, so the key IS the tenant boundary.
//
// Verified against Dojo's published OpenAPI bundle (bundled.json,
// "Dojo API 2026-02-27"):
//   • Auth is `Authorization: Basic <secret key>` — the raw key, NOT base64
//     user:pass. sk_sandbox_… = sandbox, sk_prod_… = production.
//   • `version: 2026-02-27` header on every request.
//   • `software-house-id` + `reseller-id` are REQUIRED on /terminals and
//     /terminal-sessions ("requests without them will fail"). Dojo issues
//     them to us once, as the EPOS company — they are not per merchant, so
//     they live in env, never in a shop's settings.
//   • Money is { value: minor units, currencyCode }.
//   • Errors are RFC 7807 problem details: { title, detail, status, errors }.

export const DOJO_API_BASE = "https://api.dojo.tech";
export const DOJO_API_VERSION = "2026-02-27";

export interface DojoMoney {
  value: number;
  currencyCode: string;
}

export type DojoPaymentIntentStatus =
  | "Created"
  | "Authorized"
  | "Captured"
  | "Reversed"
  | "Refunded"
  | "Canceled";

export interface DojoPaymentIntent {
  id: string;
  status: DojoPaymentIntentStatus;
  captureMode?: "Auto" | "Manual";
  amount?: DojoMoney;
  totalAmount?: DojoMoney;
  tipsAmount?: DojoMoney;
  reference?: string;
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

export type DojoTerminalStatus = "Available" | "Offline" | "InUse";

export interface DojoTerminal {
  id: string; // tm_…
  properties?: { tid?: string };
  status: DojoTerminalStatus;
  updatedAt?: string;
}

/** A finalised, successful session ends `Captured`. */
export type DojoTerminalSessionStatus =
  | "InitiateRequested"
  | "Initiated"
  | "Authorized"
  | "Captured"
  | "CancelRequested"
  | "Canceled"
  | "SignatureVerificationAccepted"
  | "SignatureVerificationRejected"
  | "SignatureVerificationRequired"
  | "Expired"
  | "Declined";

export interface DojoTerminalSession {
  id: string; // ts_…
  terminalId: string;
  status: DojoTerminalSessionStatus;
  details?: { sale?: { paymentIntentId: string }; sessionType?: string };
  statusEvents?: Array<{ status: string; createdAt: string; debugMessage?: string }>;
  [k: string]: unknown;
}

export class DojoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface DojoPartnerIds {
  softwareHouseId?: string | null;
  resellerId?: string | null;
}

/** Sandbox vs production is decided by the key itself, never by a flag. */
export function dojoKeyEnvironment(apiKey: string): "sandbox" | "production" | null {
  if (apiKey.startsWith("sk_sandbox_")) return "sandbox";
  if (apiKey.startsWith("sk_prod_")) return "production";
  return null;
}

export class DojoApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly partner: DojoPartnerIds = {},
    // Injectable for tests.
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; terminalHeaders?: boolean; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${this.apiKey}`,
      version: DOJO_API_VERSION,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers.idempotencyKey = opts.idempotencyKey;
    if (opts.terminalHeaders) {
      // Only sent when we HAVE them. Missing ids make Dojo refuse the call
      // with a clear 4xx, which is a better failure than a made-up value.
      if (this.partner.softwareHouseId) {
        headers["software-house-id"] = this.partner.softwareHouseId;
      }
      if (this.partner.resellerId) headers["reseller-id"] = this.partner.resellerId;
    }

    const res = await this.fetchImpl(`${DOJO_API_BASE}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail =
        (parsed && typeof parsed === "object" && (parsed.detail || parsed.title)) ||
        (typeof parsed === "string" ? parsed : "") ||
        res.statusText;
      throw new DojoApiError(`Dojo ${method} ${path} → ${res.status}: ${detail}`, res.status, parsed);
    }
    return parsed as T;
  }

  // ── Terminals ────────────────────────────────────────────────────────────

  listTerminals(): Promise<DojoTerminal[]> {
    return this.request<DojoTerminal[]>("GET", "/terminals", { terminalHeaders: true });
  }

  createSaleSession(terminalId: string, paymentIntentId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>("POST", "/terminal-sessions", {
      terminalHeaders: true,
      body: {
        terminalId,
        details: { sale: { paymentIntentId }, sessionType: "Sale" },
      },
    });
  }

  getTerminalSession(sessionId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "GET",
      `/terminal-sessions/${encodeURIComponent(sessionId)}`,
      { terminalHeaders: true },
    );
  }

  cancelTerminalSession(sessionId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "PUT",
      `/terminal-sessions/${encodeURIComponent(sessionId)}/cancel`,
      { terminalHeaders: true },
    );
  }

  respondToSignature(sessionId: string, accepted: boolean): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "PUT",
      `/terminal-sessions/${encodeURIComponent(sessionId)}/signature`,
      { terminalHeaders: true, body: { accepted } },
    );
  }

  // ── Payment intents ─────────────────────────────────────────────────────

  createPaymentIntent(args: {
    amountMinor: number;
    currencyCode: string;
    reference: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<DojoPaymentIntent> {
    return this.request<DojoPaymentIntent>("POST", "/payment-intents", {
      idempotencyKey: args.idempotencyKey,
      body: {
        amount: { value: args.amountMinor, currencyCode: args.currencyCode },
        // Dojo caps reference at 60 chars.
        reference: args.reference.slice(0, 60),
        description: args.description,
        captureMode: "Auto",
        metadata: args.metadata,
      },
    });
  }

  getPaymentIntent(paymentIntentId: string): Promise<DojoPaymentIntent> {
    return this.request<DojoPaymentIntent>(
      "GET",
      `/payment-intents/${encodeURIComponent(paymentIntentId)}`,
    );
  }

  cancelPaymentIntent(paymentIntentId: string): Promise<unknown> {
    return this.request("DELETE", `/payment-intents/${encodeURIComponent(paymentIntentId)}`);
  }

  // ── Pay at Table: register OUR EPOS Data endpoints with Dojo ─────────────

  registerRestIntegration(args: {
    url: string;
    username: string;
    password: string;
    capabilities: string[];
  }): Promise<unknown> {
    return this.request("PUT", "/epos/integrations/rest", {
      body: {
        url: args.url,
        capabilities: args.capabilities.map((name) => ({ name, version: "v1" })),
        auth: { authType: "basic", basic: { username: args.username, password: args.password } },
      },
    });
  }

  getIntegrations(): Promise<unknown> {
    return this.request("GET", "/epos/integrations");
  }

  /** Tell Dojo an order changed so card machines refresh it. */
  submitOrderUpdated(orderId: string): Promise<unknown> {
    return this.request("POST", "/epos/events", {
      body: { eventType: "OrderUpdated", event: { orderId } },
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  subscribeWebhook(url: string, events: string[]): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/webhooks", { body: { url, events } });
  }

  deleteWebhook(subscriptionId: string): Promise<unknown> {
    return this.request("DELETE", `/webhooks/${encodeURIComponent(subscriptionId)}`);
  }
}
