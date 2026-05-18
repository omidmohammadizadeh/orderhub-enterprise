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
  externalId: string | null;
  platform: string;
  orderSource: string;
  integrationSource: string;
  viaHubrise: boolean;
  fulfillmentType: string;
  displayId: string | null;
  status: string;
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

export const ordersClient = {
  list: (filters: OrderFilters = {}) =>
    apiClient
      .get<OrdersPage>("/v1/orders", { params: filters })
      .then((r) => r.data),

  live: (locationId?: string) =>
    apiClient
      .get<Order[]>("/v1/orders/live", { params: locationId ? { locationId } : {} })
      .then((r) => r.data),

  get: (id: string) =>
    apiClient.get<Order>(`/v1/orders/${id}`).then((r) => r.data),

  updateStatus: (
    id: string,
    status: string,
    opts: { note?: string; cancelReason?: string } = {},
  ) =>
    apiClient
      .patch<Order>(`/v1/orders/${id}/status`, { status, ...opts })
      .then((r) => r.data),
};
