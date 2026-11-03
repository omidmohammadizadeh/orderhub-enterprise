// Eat For Less — the customer's side of the website: their account and their
// orders. The same endpoints the app uses, with the customer's own token. It
// is kept apart from apiClient, which carries an OrderHub staff session: a
// shop owner browsing eatforless.co.uk must never order as their staff login.

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "/api").replace(/\/+$/, "");
const TOKEN_KEY = "efl.customerToken";

export class EflApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function readEflToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeEflToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage: the session lasts for this page only.
  }
}

/** Called when the API says the token is no good, so the session can clear. */
let onUnauthorized: () => void = () => {};
export function setEflUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function messageOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const m = (json as { message?: unknown }).message;
  if (typeof m === "string") return m;
  if (Array.isArray(m) && typeof m[0] === "string") return m[0];
  return null;
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const token = opts.auth === false ? null : readEflToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      if (res.status === 401 && token) onUnauthorized();
      throw new EflApiError(messageOf(json) ?? `Something went wrong (${res.status}).`, res.status);
    }
    return json as T;
  } catch (err) {
    if (err instanceof EflApiError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new EflApiError("That took too long. Check your connection and try again.", 0);
    }
    throw new EflApiError("You seem to be offline. Check your connection and try again.", 0);
  } finally {
    clearTimeout(timer);
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export type EflCustomer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
};

export type EflAuthResult = { accessToken: string; customer: EflCustomer };

export type EflMe = { phone: string | null; phoneVerified: boolean; marketingOptIn: boolean };

export type EflCheckoutBody = {
  idempotencyKey: string;
  fulfillmentType: "DELIVERY" | "PICKUP";
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city: string;
    postcode?: string;
    latitude?: number;
    longitude?: number;
  };
  items: Array<{
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    modifiers: Array<{
      name: string;
      price: number;
      optionId?: string | null;
      depth?: number;
      path?: string[];
      parentOptionId?: string | null;
    }>;
    skuPlu?: string | null;
    skuName?: string | null;
    notes?: string;
  }>;
  subtotal: number;
  deliveryFee?: number;
  tipAmount?: number;
  total: number;
  scheduledFor?: string;
};

export type EflCheckoutResult = {
  orderId: string;
  displayId: string | null;
  total: number;
  clientSecret: string | null;
  /** Set only while orders are still charged on the shop's own account. */
  stripeAccountId: string | null;
  publishableKey?: string | null;
  amountPence: number | null;
  checkoutUrl: string | null;
};

type EflMoney = number | string;

export type EflOrderSummary = {
  id: string;
  displayId: string | null;
  status: string;
  total: EflMoney;
  createdAt: string;
  fulfillmentType: string;
  location: { name: string; eflListing: { id: string } | null } | null;
  brand: { name: string } | null;
};

export type EflOrderDetail = {
  id: string;
  displayId: string | null;
  status: string;
  paymentStatus?: string;
  fulfillmentType: string;
  estimatedReadyAt?: string | null;
  cancelReason?: string | null;
  total: EflMoney;
  location?: { name?: string } | null;
  items: Array<{ id: string; name: string; quantity: number; unitPrice: EflMoney }>;
  driver: { name?: string | null } | null;
  driverEtaMinutes: number | null;
  deliveryPin: string | null;
  handedOver: boolean;
};

// ── Calls ──────────────────────────────────────────────────────────────────

export const eflCustomerApi = {
  config: () => request<{ stripePublishableKey: string | null }>("GET", "/v1/efl/config", undefined, { auth: false }),

  loginEmail: (email: string, password: string) =>
    request<EflAuthResult>("POST", "/v1/customer-auth/login", { email, password }, { auth: false }),

  /** The confirmation link comes back to this site (see /auth/confirm). */
  signupEmail: (input: { email: string; password: string; firstName: string; lastName: string; marketingOptIn: boolean }) =>
    request<{ pendingVerification: true; email: string }>(
      "POST",
      "/v1/customer-auth/signup",
      { ...input, origin: window.location.origin },
      { auth: false },
    ),

  verifyEmail: (token: string) =>
    request<EflAuthResult>("GET", `/v1/customer-auth/verify?token=${encodeURIComponent(token)}`, undefined, { auth: false }),

  /** A Google ID token from the "Continue with Google" button. */
  signInGoogle: (idToken: string) =>
    request<EflAuthResult>("POST", "/v1/customer-auth/native", { provider: "google", idToken }, { auth: false }),

  /** Checks the token and returns a fresh one (a sliding session). */
  me: () => request<EflCustomer & { accessToken?: string }>("GET", "/v1/customer-auth/me"),

  eflMe: () => request<EflMe>("GET", "/v1/efl/me"),

  startPhone: (phone: string) => request<{ sent: true; phone: string }>("POST", "/v1/efl/me/phone/start", { phone }),

  verifyPhone: (code: string) => request<{ verified: true }>("POST", "/v1/efl/me/phone/verify", { code }),

  checkout: (listingId: string, body: EflCheckoutBody) =>
    request<EflCheckoutResult>("POST", `/v1/efl/shops/${encodeURIComponent(listingId)}/checkout`, body, { timeoutMs: 60_000 }),

  myOrders: () => request<EflOrderSummary[]>("GET", "/v1/efl/me/orders"),

  myOrder: (orderId: string) => request<EflOrderDetail>("GET", `/v1/efl/me/orders/${encodeURIComponent(orderId)}`),
};
