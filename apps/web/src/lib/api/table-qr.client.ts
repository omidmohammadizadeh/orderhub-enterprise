// QR at table — the guest-facing client for /t/[token].
//
// Deliberately built on plain `fetch` rather than the shared `apiClient`
// axios instance: a diner's phone has no session, and apiClient's 401
// interceptor would try a token refresh and then bounce them to /login.
// Every route here is @Public() on the API and keyed only by the table's
// rotatable QR token.

import type { MenuCategory } from "./menus.client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/** Error carrying the HTTP status so the page can branch on 404 vs 403. */
export class TableQrError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TableQrError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    // Offline / flaky restaurant wifi. Status 0 marks it retryable.
    throw new TableQrError("We couldn't reach the restaurant just now.", 0);
  }
  return unwrap<T>(res);
}

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Nest error bodies are { statusCode, message, error }, where message
    // is either a string or an array of validation strings.
    const raw = (body as { message?: string | string[] } | null)?.message;
    const message = Array.isArray(raw) ? raw[0] : raw;
    throw new TableQrError(message || "Something went wrong.", res.status);
  }
  return body as T;
}

// ── Shapes (mirror apps/api/src/modules/tables/table-qr.service.ts) ─────────

export interface TableQrResolved {
  tableId: string;
  tableName: string;
  locationId: string;
  locationName: string | null;
  brandId: string | null;
  brandName: string | null;
  brandSlug: string | null;
  /** True once a waiter (or an earlier scan) opened the tab. */
  tabOpen: boolean;
  covers: number | null;
  /**
   * How this shop runs QR ordering, set per location in Tables →
   * Payment options.
   *   PAY_LATER — send to the kitchen now, settle with staff at the end.
   *   PAY_NOW   — the phone pays first; nothing is cooked until it has.
   */
  paymentMode: TableQrPaymentMode;
}

export type TableQrPaymentMode = "PAY_LATER" | "PAY_NOW";

export interface TableQrTabLine {
  id: string;
  name: string;
  quantity: number;
  totalPrice: number;
}

export interface TableQrTab {
  tableName: string;
  open: boolean;
  items: TableQrTabLine[];
  total: number;
  /** Absent when the tab hasn't been opened yet. */
  paymentStatus?: string | null;
  paymentMode?: TableQrPaymentMode;
}

export interface TableQrOrderItem {
  name: string;
  quantity: number;
  /** Includes modifier prices — matches what the POS sends. */
  unitPrice: number;
  totalPrice: number;
  modifiers?: Array<{ name: string; price: number; quantity?: number }>;
  notes?: string | null;
  /** Load-bearing: KDS station routing matches on this. Never omit it. */
  menuItemId?: string | null;
}

export interface TableQrOrderResult {
  orderId: string;
  tableName: string;
  mode: "OPEN" | "ROUND";
}

/**
 * The answer to "I want to pay for this round". The order already exists
 * server-side by the time this lands — unpaid, and held back from the
 * kitchen until Stripe says the money arrived.
 */
export interface TableQrCheckoutResult {
  orderId: string;
  tableName: string;
  /** A repeat of a basket that already went through. No sheet to mount. */
  alreadyPaid?: boolean;
  clientSecret?: string;
  /** The connected account the intent was minted on. Stripe.js must be
   *  constructed with it or the secret won't confirm. */
  stripeAccountId?: string;
  /** What Stripe will actually take, in minor units. */
  amountPence?: number;
  subtotal: number;
  serviceCharge: number;
  serviceChargeLabel: string;
  total: number;
}

export interface TableQrOrderStatus {
  orderId: string;
  displayId: string | null;
  orderNumber: number | null;
  status: string;
  paymentStatus: string;
  total: number;
  paid: boolean;
}

/**
 * The public storefront payload, narrowed to what a table guest needs.
 * Same endpoint the /order/[slug] storefront uses, so prices, 86'd items
 * and modifier groups are identical to what the customer site shows.
 */
export interface TableStorefront {
  location: { id: string; name: string; logoUrl?: string | null };
  brand: { id: string; name: string; logoUrl?: string | null };
  menu: { id: string; categories: MenuCategory[] } | null;
  /** Brand-wide modifier catalog — required to resolve per-SKU groups.
   *  Loosely typed here exactly as the storefront types it. */
  brandModifierGroups?: any[];
  directConfig?: { showItemImages?: boolean };
}

// ── Calls ──────────────────────────────────────────────────────────────────

export const tableQrClient = {
  resolve: (token: string) =>
    getJson<TableQrResolved>(
      `${API_BASE}/v1/table-qr/${encodeURIComponent(token)}`,
    ),

  tab: (token: string) =>
    getJson<TableQrTab>(
      `${API_BASE}/v1/table-qr/${encodeURIComponent(token)}/tab`,
    ),

  sendRound: async (
    token: string,
    body: {
      items: TableQrOrderItem[];
      customerName?: string;
      notes?: string | null;
      /**
       * Stable id for THIS basket. The server replays the same answer
       * instead of cooking a second time, so a retry after a dropped
       * connection can't plate the round twice.
       */
      requestId?: string;
    },
  ) => {
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/v1/table-qr/${encodeURIComponent(token)}/order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // The round may or may not have landed, so the copy must not promise
      // either way — the page tells the guest to check My tab.
      throw new TableQrError("We couldn't reach the kitchen just now.", 0);
    }
    return unwrap<TableQrOrderResult>(res);
  },

  /**
   * Pay-before-kitchen. Writes the order unpaid and hands back a Stripe
   * direct-charge secret for the wallet sheet. The kitchen hears nothing
   * until the payment webhook confirms, so a failed or abandoned card
   * leaves no food cooked.
   */
  checkout: async (
    token: string,
    body: {
      items: TableQrOrderItem[];
      customerName?: string;
      notes?: string | null;
      /** Same stable per-basket id as sendRound — a retry replays the
       *  same intent instead of writing a second order. */
      requestId?: string;
    },
  ) => {
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/v1/table-qr/${encodeURIComponent(token)}/checkout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // Nothing was charged — the request never arrived. Safe to retry,
      // and the requestId makes a duplicate impossible either way.
      throw new TableQrError("We couldn't start your payment just now.", 0);
    }
    return unwrap<TableQrCheckoutResult>(res);
  },

  /**
   * Did it land? Polled after the card is confirmed, because the money
   * arriving (Stripe webhook) and the kitchen being told are the same
   * event server-side — the phone shouldn't claim "sent" before it.
   */
  orderStatus: (token: string, orderId: string) =>
    getJson<TableQrOrderStatus>(
      `${API_BASE}/v1/table-qr/${encodeURIComponent(token)}/orders/${encodeURIComponent(orderId)}`,
    ),

  /**
   * The menu, fetched through the storefront endpoint. `:slug` there also
   * resolves a raw location id (`OR: [{ onlineOrderingSlug }, { slug }, { id }]`),
   * which is what the QR resolve gives us — no extra lookup needed.
   *
   * `channel=POS` and NO brand pin, deliberately, and both halves matter:
   *
   *   - POS, because the guest is sitting in the restaurant. The operator
   *     sets one menu up for the shop and expects the table to match the
   *     till, and a shop's POS menu is often a different menu at different
   *     prices from the one it publishes to the web.
   *   - No brand, because this used to pin `Location.brandId` — the same
   *     placeholder field that once put another shop's menu on a Best Kebab
   *     receipt. Unpinned, the resolution keys off the location exactly as
   *     MenusService.findActiveMenuForLocation does for the till, which is
   *     the definition of "the same menu as the POS".
   */
  storefront: (locationId: string) =>
    getJson<TableStorefront>(
      `${API_BASE}/v1/ordering/store/${encodeURIComponent(locationId)}?channel=POS`,
    ),
};
