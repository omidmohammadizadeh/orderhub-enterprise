import { apiClient } from "./client";
import type { OrderEventPayload } from "@orderhub/shared";

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers: Array<{ name: string; price: number; quantity?: number }>;
  notes?: string | null;
}

export interface StatusHistoryEntry {
  id: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  note?: string | null;
  createdAt: string;
}

export interface Order {
  id: string;
  tenantId: string;
  locationId: string;
  /** Phase AW-26 — lifetime order count for this customer (by phone).
   *  1 = NEW. Attached server-side by OrdersService.findLiveOrders. */
  customerVisitCount?: number;
  customerVisitTag?: string;
  externalId: string | null;
  platform: string;
  orderSource: string;
  integrationSource: string;
  viaHubrise: boolean;
  fulfillmentType: string;
  displayId: string | null;
  /** Phase AM — sequential per-tenant POS/DIRECT order number ("#1"). */
  orderNumber?: number | null;
  status: string;
  /** Phase AM payment fields. */
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  customerInfo: { name: string; phone?: string; email?: string };
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city: string;
    postcode: string;
  } | null;
  items: OrderItem[];
  statusHistory: StatusHistoryEntry[];
  subtotal: number;
  taxAmount: number;
  deliveryFee: number;
  discount: number;
  total: number;
  specialInstructions?: string | null;
  scheduledFor?: string | null;
  cancelReason?: string | null;
  receivedAt: string;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
}

export interface OrdersPage {
  total: number;
  page: number;
  limit: number;
  orders: Order[];
}

export interface OrderFilters {
  locationId?: string;
  status?: string | string[];
  platform?: string;
  orderSource?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

// ── Decimal coercion ────────────────────────────────────────────────────────
// Prisma serialises Decimal columns as strings in JSON (to preserve precision),
// but our React components use them as numbers (`.toFixed()`, comparisons).
// Without normalisation `order.total.toFixed(2)` throws TypeError on the
// client and crashes the whole orders board with a hydration error.
// Coerce once at the API boundary so component code can stay arithmetic.

function n(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function normaliseOrder(o: Order): Order {
  return {
    ...o,
    subtotal: n(o.subtotal),
    taxAmount: n(o.taxAmount),
    deliveryFee: n(o.deliveryFee),
    discount: n(o.discount),
    total: n(o.total),
    items: o.items?.map((i) => ({
      ...i,
      unitPrice: n(i.unitPrice),
      totalPrice: n(i.totalPrice),
      modifiers: (i.modifiers ?? []).map((m) => ({
        ...m,
        price: n(m.price),
      })),
    })) ?? [],
  };
}

export const ordersClient = {
  list: (filters: OrderFilters = {}) =>
    apiClient
      .get<OrdersPage>("/v1/orders", { params: filters })
      .then((r) => ({
        ...r.data,
        orders: r.data.orders.map(normaliseOrder),
      })),

  live: (locationId?: string, opts?: { signal?: AbortSignal }) =>
    apiClient
      .get<Order[]>("/v1/orders/live", {
        params: locationId ? { locationId } : {},
        // React Query's signal — aborts the request when the observer
        // unmounts or the location changes, instead of letting stale
        // fetches complete and count against the rate limit.
        signal: opts?.signal,
      })
      .then((r) => r.data.map(normaliseOrder)),

  get: (id: string) =>
    apiClient.get<Order>(`/v1/orders/${id}`).then((r) => normaliseOrder(r.data)),

  updateStatus: (
    id: string,
    status: string,
    opts: { note?: string; cancelReason?: string } = {},
  ) =>
    apiClient
      .patch<Order>(`/v1/orders/${id}/status`, { status, ...opts })
      .then((r) => normaliseOrder(r.data)),
};
