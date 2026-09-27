// Retail R1 — barcodes, stock and returns (apps/api/src/modules/retail).

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
  returns: Array<{
    id: string;
    amount: number;
    method: string | null;
    reason: string | null;
    createdAt: string;
  }>;
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
  }) =>
    apiClient
      .post<{ refundId: string; amount: number; method: "CASH" | "CARD"; sale: SaleForReturn }>(
        "/v1/retail/returns",
        body,
      )
      .then((r) => r.data),
};
