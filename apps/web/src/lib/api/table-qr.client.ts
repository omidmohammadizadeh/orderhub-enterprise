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
}

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
   * The menu, fetched through the storefront endpoint. `:slug` there also
   * resolves a raw location id (`OR: [{ onlineOrderingSlug }, { slug }, { id }]`),
   * which is what the QR resolve gives us — no extra lookup needed. The
   * ?brand pin makes a multi-brand kitchen serve the right brand's menu.
   */
  storefront: (locationId: string, brandId?: string | null) =>
    getJson<TableStorefront>(
      `${API_BASE}/v1/ordering/store/${encodeURIComponent(locationId)}` +
        (brandId ? `?brand=${encodeURIComponent(brandId)}` : ""),
    ),
};
