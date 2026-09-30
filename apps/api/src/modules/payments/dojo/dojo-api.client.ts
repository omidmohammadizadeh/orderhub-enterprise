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
  /** What the machine is showing: InsertCard, EnterPin, PresentCard, Approved… */
  notificationEvents?: Array<{ notificationType: string; createdAt: string }>;
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

/**
 * One line on the customer's receipt.
 *
 * Deliberately minimal: Dojo documents these fields in its response examples
 * but not in the request body, and the modifier shape isn't specified at all.
 * So modifiers are folded into `name` ("VEGETARIAN (10\", deep pan)") and the
 * price is the line total — which reads correctly on a receipt and can't be
 * rejected for a field we guessed at.
 */
export interface DojoItemLine {
  name: string;
  quantity: number;
  plu?: string;
  amountTotal: { value: number; currencyCode: string };
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
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${this.apiKey}`,
      version: DOJO_API_VERSION,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers.idempotencyKey = opts.idempotencyKey;
    // Dojo's spec only demands these on Terminals/Terminal Sessions, but our
    // partner manager asked for them on "all posts to us, payment intents and
    // terminal sessions" (Philip Wells, 2026-09-23) — so every call carries
    // them. Only sent when we HAVE them: a missing id makes Dojo refuse with a
    // clear 4xx, which is a better failure than a made-up value.
    if (this.partner.softwareHouseId) {
      headers["software-house-id"] = this.partner.softwareHouseId;
    }
    // reseller-id belongs on /terminals only. Dojo asked us to drop it from
    // payment intents and terminal sessions while KEEPING software-house-id on
    // both (Philip Wells, 2026-09-30 certification call). Scoped by path rather
    // than by an argument at each call site, because "remember to pass the flag"
    // is how one endpoint quietly keeps sending it.
    const resellerAllowed = !/^\/(payment-intents|terminal-sessions)\b/.test(path);
    if (this.partner.resellerId && resellerAllowed) {
      headers["reseller-id"] = this.partner.resellerId;
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
      // RFC 7807: the useful part of a Dojo 400 is usually `errors`, a
      // field→messages map. Without it every validation failure reads
      // "One or more validation errors occurred", which names nothing.
      // Dojo is inconsistent about case: validation 400s use RFC 7807's
      // lowercase `detail`/`errors`, refund 400s answer in PascalCase
      // (`{"Status":400,"Detail":"…"}`). Read either.
      const pick = (key: string): any => {
        if (!parsed || typeof parsed !== "object") return undefined;
        const hit = Object.keys(parsed).find((k) => k.toLowerCase() === key);
        return hit ? (parsed as Record<string, unknown>)[hit] : undefined;
      };
      const errs = pick("errors");
      const fields =
        errs && typeof errs === "object"
          ? Object.entries(errs as Record<string, unknown>)
              .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`)
              .join("; ")
          : "";
      // Last resort: Dojo sometimes 400s with a body that is neither RFC 7807
      // nor a string (refunds did, 2026-09-23, leaving only "Bad Request" to
      // go on). Carry the raw body so the next failure names itself.
      const said = pick("detail") || pick("title");
      const raw = !fields && !said && parsed && typeof parsed === "object" ? JSON.stringify(parsed).slice(0, 300) : "";
      const detail =
        [
          said || (typeof parsed === "string" ? parsed.slice(0, 300) : "") || res.statusText,
          fields,
          raw,
        ]
          .filter(Boolean)
          .join(" — ");
      throw new DojoApiError(`Dojo ${method} ${path} → ${res.status}: ${detail}`, res.status, parsed);
    }
    return parsed as T;
  }

  // ── Terminals ────────────────────────────────────────────────────────────

  listTerminals(): Promise<DojoTerminal[]> {
    return this.request<DojoTerminal[]>("GET", "/terminals");
  }

  createSaleSession(terminalId: string, paymentIntentId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>("POST", "/terminal-sessions", {
      body: {
        terminalId,
        details: { sale: { paymentIntentId }, sessionType: "Sale" },
      },
    });
  }

  /**
   * Money back to a card that is PRESENT at the machine. Dojo will not refund
   * or reverse a terminal capture through the payment intent (both answer 400
   * — sandbox, 2026-09-23); a card-present refund is a terminal session that
   * runs a negative transaction on the machine.
   *
   * Shapes verified against the live API with Dojo's own public sandbox key:
   * sessionType is one of Sale | MatchedRefund | UnlinkedRefund, `amount` is
   * always the money OBJECT, and on a matched refund it is optional — leave
   * it out for the whole payment, send it to give back part.
   */
  createRefundSession(args: {
    terminalId: string;
    /** Omit for an unlinked refund (no original sale to point at). */
    paymentIntentId?: string;
    /** Required when unlinked; on a matched refund only for a PART refund. */
    amountMinor?: number;
    currencyCode?: string;
  }): Promise<DojoTerminalSession> {
    const amount =
      args.amountMinor !== undefined
        ? { amount: { value: args.amountMinor, currencyCode: (args.currencyCode ?? "GBP").toUpperCase() } }
        : {};
    const details = args.paymentIntentId
      ? { matchedRefund: { paymentIntentId: args.paymentIntentId, ...amount }, sessionType: "MatchedRefund" }
      : { unlinkedRefund: { ...amount }, sessionType: "UnlinkedRefund" };
    return this.request<DojoTerminalSession>("POST", "/terminal-sessions", {
      body: { terminalId: args.terminalId, details },
    });
  }

  getTerminalSession(sessionId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "GET",
      `/terminal-sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  cancelTerminalSession(sessionId: string): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "PUT",
      `/terminal-sessions/${encodeURIComponent(sessionId)}/cancel`,
    );
  }

  respondToSignature(sessionId: string, accepted: boolean): Promise<DojoTerminalSession> {
    return this.request<DojoTerminalSession>(
      "PUT",
      `/terminal-sessions/${encodeURIComponent(sessionId)}/signature`,
      { body: { accepted } },
    );
  }

  // ── Payment intents ─────────────────────────────────────────────────────

  /**
   * `amountMinor` is the goods only. Dojo defines `amount` as "the amount
   * intended to be collected ... EXCLUDING tipsAmount, serviceChargeAmount and
   * cashbackAmount", so a tip or a service charge folded into it would be
   * charged correctly but printed as part of the food.
   *
   * `itemLines` is what puts a breakdown on the customer's receipt. Without it
   * Dojo prints a bare total, which is what their certification flagged
   * (2026-09-30).
   */
  createPaymentIntent(args: {
    amountMinor: number;
    currencyCode: string;
    reference: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
    tipsMinor?: number;
    serviceChargeMinor?: number;
    itemLines?: DojoItemLine[];
  }): Promise<DojoPaymentIntent> {
    const money = (value: number) => ({ value, currencyCode: args.currencyCode });
    return this.request<DojoPaymentIntent>("POST", "/payment-intents", {
      idempotencyKey: args.idempotencyKey,
      body: {
        amount: money(args.amountMinor),
        // Dojo caps reference at 60 chars.
        reference: args.reference.slice(0, 60),
        description: args.description,
        captureMode: "Auto",
        ...(args.tipsMinor ? { tipsAmount: money(args.tipsMinor) } : {}),
        ...(args.serviceChargeMinor
          ? { serviceChargeAmount: money(args.serviceChargeMinor) }
          : {}),
        ...(args.itemLines?.length ? { itemLines: args.itemLines } : {}),
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

  /** Refund a captured intent (full or partial). `amountMinor` in pence. */
  refundPaymentIntent(args: {
    paymentIntentId: string;
    amountMinor: number;
    reason?: string;
    idempotencyKey: string;
  }): Promise<{ refundId?: string | null; paymentIntentId?: string | null }> {
    return this.request("POST", `/payment-intents/${encodeURIComponent(args.paymentIntentId)}/refunds`, {
      idempotencyKey: args.idempotencyKey,
      body: {
        amount: args.amountMinor,
        ...(args.reason ? { refundReason: args.reason.slice(0, 1024) } : {}),
      },
    });
  }

  /**
   * Full-amount undo of a payment Dojo has NOT settled yet. Dojo refuses a
   * refund on a fresh `captureMode:Auto` capture ("Your refund request was not
   * successful. Status: Failed.") — until settlement, reversal is the only
   * route back. Allowed on a captured Auto intent within 7 days; full amount
   * only; no body, the id is the whole request.
   */
  reversePaymentIntent(paymentIntentId: string, idempotencyKey?: string): Promise<unknown> {
    return this.request("POST", `/payment-intents/${encodeURIComponent(paymentIntentId)}/reversal`, {
      idempotencyKey,
    });
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

  /** Event names this account may subscribe to, grouped by model. */
  listWebhookEventTypes(): Promise<Array<{ model?: string; events?: string[] }>> {
    return this.request("GET", "/webhooks/events");
  }

  subscribeWebhook(url: string, events: string[]): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/webhooks", { body: { url, events } });
  }

  deleteWebhook(subscriptionId: string): Promise<unknown> {
    return this.request("DELETE", `/webhooks/${encodeURIComponent(subscriptionId)}`);
  }
}
