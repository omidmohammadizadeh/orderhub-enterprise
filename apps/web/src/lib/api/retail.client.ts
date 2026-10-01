// Retail R1 — barcodes, stock and returns (apps/api/src/modules/retail).

import type { MultiBuyDeal } from "@orderhub/shared";
import { apiClient } from "./client";

export interface BarcodeEntry {
  barcode: string;
  variantId: string;
  menuItemId: string;
  name: string;
  productName: string;
  variantName: string;
  price: number;
  sku: string | null;
  /** Challenge 25 — 16 or 18 when the product is age-restricted. */
  minAge?: number | null;
  /** Weighed products are stocked (and received) in grams. */
  sellBy?: "KG" | "100G" | null;
}

export interface RetailVariant {
  id: string;
  menuItemId: string;
  name: string;
  options: Record<string, string>;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  costPrice: number | null;
  trackStock: boolean;
  lowStockAt: number | null;
  isActive: boolean;
  stock: number;
}

export interface RetailProduct {
  id: string;
  name: string;
  basePrice: number;
  plu: string | null;
  imageUrl: string | null;
  /** Weighed products: priced per kg / 100 g and stocked in grams. */
  sellBy?: "KG" | "100G" | null;
  variants: RetailVariant[];
}

export type BarcodeLookup =
  | { code: string; found: false }
  | {
      code: string;
      found: true;
      onTill: boolean;
      variant: RetailVariant;
      product: { id: string; name: string };
    };

export interface ImportSummary {
  products: number;
  created: number;
  updated: number;
  variantsCreated: number;
  variantsUpdated: number;
  stockSet: number;
  errors: Array<{ row: number; message: string }>;
  menu: { id: string; name: string; created: boolean } | null;
  dryRun: boolean;
}

export interface SaleForReturn {
  order: {
    id: string;
    displayId: string | null;
    orderNumber: number | null;
    createdAt: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string | null;
    total: number;
    subtotal: number;
    discount: number;
    currency: string;
    locationName: string | null;
  };
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    returnable: number;
  }>;
  refunded: number;
  refundable: number;
  canReturn: boolean;
  original:
    | { method: "CASH"; provider: null; supported: true }
    | { method: "CARD"; provider: string; supported: boolean; note?: string };
  /** A card-machine refund started earlier and not yet finished. */
  pendingOnMachine: { amount: number; startedAt: string | null } | null;
  returns: Array<{
    id: string;
    amount: number;
    method: string | null;
    reason: string | null;
    createdAt: string;
  }>;
}

export type ReturnResult =
  | { pending?: false; refundId: string; amount: number; method: "CASH" | "CARD"; sale: SaleForReturn }
  /** Card-present (Dojo): the customer must tap their card — poll until done. */
  | { pending: true; method: "CARD"; provider: "DOJO"; amount: number; terminalSessionId: string };

export type MachineReturnStatus =
  | { active: false; sale: SaleForReturn }
  | {
      active: true;
      amount: number;
      status: string | null;
      /** What the machine is showing: PresentCard, EnterPin… */
      prompt: string | null;
      done: boolean;
      failed: boolean;
      message?: string;
      sale?: SaleForReturn;
    };

// ── R3 picking ─────────────────────────────────────────────────────────────

export interface PickSub {
  variantId?: string | null;
  menuItemId?: string | null;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface PickLine {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  notes: string | null;
  modifiers: Array<{ name: string }> | null;
  aisle: string;
  aisleOrder: number;
  barcodes: string[];
  variantId: string | null;
  substitution: "BEST_MATCH" | "NONE";
  pick: { picked: number; sub?: PickSub | null; grams?: number | null } | null;
  /** Weighed lines: total grams ordered; picked by weight, not count. */
  weightGrams?: number | null;
}

export interface PickOrder {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: string;
  fulfillmentType: string;
  orderSource: string;
  customerName: string;
  scheduledFor: string | null;
  createdAt: string;
  specialInstructions: string | null;
  paymentMethod: string | null;
  paymentStatus: string;
  total: number;
  picking: { completedAt: string; refund: number; settledBy: string } | null;
  lines: PickLine[];
}

export interface StockReport {
  rows: Array<{
    variantId: string;
    product: string;
    variant: string;
    barcode: string | null;
    sku: string | null;
    quantity: number;
    price: number;
    cost: number | null;
    value: number | null;
    lowStockAt: number | null;
    low: boolean;
    trackStock: boolean;
  }>;
  totals: { variants: number; units: number; valueAtCost: number; low: number; uncosted: number };
}

export interface VariantInput {
  name?: string;
  barcode?: string | null;
  sku?: string | null;
  price?: number | null;
  costPrice?: number | null;
  trackStock?: boolean;
  lowStockAt?: number | null;
  isActive?: boolean;
}

const base = (locationId: string) => `/v1/retail/locations/${locationId}`;

export const retailClient = {
  barcodes: (locationId: string) =>
    apiClient.get<BarcodeEntry[]>(`${base(locationId)}/barcodes`).then((r) => r.data),

  /** Multi-buys live on this till (POS channel). */
  deals: (locationId: string) =>
    apiClient.get<{ multiBuys: MultiBuyDeal[] }>(`${base(locationId)}/deals`).then((r) => r.data),

  lookup: (locationId: string, code: string) =>
    apiClient
      .get<BarcodeLookup>(`${base(locationId)}/lookup`, { params: { code } })
      .then((r) => r.data),

  products: (locationId: string, opts: { q?: string; low?: boolean } = {}) =>
    apiClient
      .get<{ products: RetailProduct[]; total: number }>(`${base(locationId)}/products`, {
        params: { ...(opts.q ? { q: opts.q } : {}), ...(opts.low ? { low: "1" } : {}) },
      })
      .then((r) => r.data),

  importRows: (locationId: string, rows: Array<Record<string, unknown>>, dryRun = false) =>
    apiClient
      .post<ImportSummary>(`${base(locationId)}/import`, { rows, dryRun })
      .then((r) => r.data),

  createVariant: (menuItemId: string, body: VariantInput) =>
    apiClient.post<RetailVariant>(`/v1/retail/items/${menuItemId}/variants`, body).then((r) => r.data),

  updateVariant: (variantId: string, body: VariantInput) =>
    apiClient.patch<RetailVariant>(`/v1/retail/variants/${variantId}`, body).then((r) => r.data),

  adjustStock: (
    locationId: string,
    body: { variantId: string; mode: "delta" | "count"; quantity: number; reason?: string },
  ) =>
    apiClient
      .post<{ variantId: string; quantity: number; change: number }>(`${base(locationId)}/stock/adjust`, body)
      .then((r) => r.data),

  findSale: (locationId: string, code: string) =>
    apiClient
      .get<SaleForReturn>(`${base(locationId)}/returns/lookup`, { params: { code } })
      .then((r) => r.data),

  createReturn: (body: {
    orderId: string;
    lines: Array<{ orderItemId: string; quantity: number; restock?: boolean }>;
    refundMethod?: "ORIGINAL" | "CASH";
    reason?: string;
    managerPin?: string;
    terminalId?: string;
  }) =>
    apiClient
      .post<ReturnResult>("/v1/retail/returns", body)
      .then((r) => r.data),

  // ── R3 picking ──
  pickList: (locationId: string) =>
    apiClient.get<{ orders: PickOrder[] }>(`${base(locationId)}/picking`).then((r) => r.data),
  startPicking: (orderId: string) => apiClient.post(`/v1/retail/picking/${orderId}/start`).then((r) => r.data),
  pickLine: (orderId: string, itemId: string, body: { picked: number; sub?: PickSub | null; grams?: number }) =>
    apiClient.patch(`/v1/retail/picking/${orderId}/lines/${itemId}`, body).then((r) => r.data),
  completePicking: (orderId: string) =>
    apiClient
      .post<{ refund: number; settledBy: "CARD" | "CASH_COLLECT" | "OWED" | "NONE"; missing: number; substituted: number }>(
        `/v1/retail/picking/${orderId}/complete`,
      )
      .then((r) => r.data),

  // ── R2-lite ──
  receive: (locationId: string, body: { reference?: string; lines: Array<{ variantId: string; quantity: number }> }) =>
    apiClient
      .post<{ lines: number; units: number; reference: string | null }>(`${base(locationId)}/stock/receive`, body)
      .then((r) => r.data),
  stockReport: (locationId: string) =>
    apiClient.get<StockReport>(`${base(locationId)}/stock/report`).then((r) => r.data),

  /** Poll a return being refunded on the Dojo card machine. */
  pollDojoReturn: (orderId: string) =>
    apiClient.post<MachineReturnStatus>("/v1/retail/returns/dojo/poll", { orderId }).then((r) => r.data),
};
