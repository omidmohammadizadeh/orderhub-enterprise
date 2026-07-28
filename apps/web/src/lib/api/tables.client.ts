import { apiClient } from "./client";

// Table Tabs (dine-in) — a location's physical tables and their open/free state.

export type TableShape = "SQUARE" | "ROUND" | "RECT";

export interface RestaurantTable {
  id: string;
  tenantId: string;
  locationId: string;
  name: string;
  seats: number | null;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "FREE" | "OCCUPIED";
  currentOrderId: string | null;
  openedAt: string | null;
  createdAt: string;
  updatedAt: string;

  // ── Floor plan ──────────────────────────────────────────────────────
  // posX/posY are grid cells, and null means "never placed" — those tables
  // live in the unplaced tray rather than at 0,0 on top of each other.
  posX: number | null;
  posY: number | null;
  shape: TableShape;
  /** Size in grid cells, 1–6. */
  width: number;
  height: number;

  // ── Availability ────────────────────────────────────────────────────
  bookableOnline: boolean;
  outOfService: boolean;
  outOfServiceNote: string | null;

  // ── QR at table ─────────────────────────────────────────────────────
  qrToken: string | null;
  qrEnabled: boolean;

  // ── Current sitting (cleared when the table is freed) ───────────────
  covers: number | null;
  serverId: string | null;
  serverName: string | null;
}

export interface UpsertTableInput {
  locationId: string;
  name: string;
  seats?: number | null;
  area?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  posX?: number | null;
  posY?: number | null;
  shape?: TableShape;
  width?: number;
  height?: number;
  bookableOnline?: boolean;
  outOfService?: boolean;
  outOfServiceNote?: string | null;
  qrEnabled?: boolean;
}

/** One tile's placement, as the floor-plan editor saves them in bulk. */
export interface LayoutNode {
  id: string;
  posX: number;
  posY: number;
  shape?: TableShape;
  width?: number;
  height?: number;
  area?: string | null;
}

/** Who's on the table right now. */
export interface SittingInput {
  covers?: number | null;
  serverId?: string | null;
  serverName?: string | null;
}

export const tablesClient = {
  list: (locationId: string) =>
    apiClient
      .get<RestaurantTable[]>(`/v1/tables`, { params: { locationId } })
      .then((r) => r.data),

  create: (input: UpsertTableInput) =>
    apiClient.post<RestaurantTable>(`/v1/tables`, input).then((r) => r.data),

  update: (id: string, input: Partial<UpsertTableInput>) =>
    apiClient
      .patch<RestaurantTable>(`/v1/tables/${id}`, input)
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/v1/tables/${id}`).then((r) => r.data),

  // An empty body still means "just open the tab" — the API only applies the
  // sitting when one of covers/serverId/serverName is actually present.
  seat: (id: string, input?: SittingInput) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/seat`, input ?? {})
      .then((r) => r.data),

  free: (id: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/free`, {})
      .then((r) => r.data),

  linkOrder: (id: string, orderId: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/link-order`, { orderId })
      .then((r) => r.data),

  // Service essentials — the party moved seats, or two tables became one.
  move: (id: string, toTableId: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/move`, { toTableId })
      .then((r) => r.data),

  merge: (id: string, intoTableId: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/merge`, { intoTableId })
      .then((r) => r.data),

  // ── Floor plan ────────────────────────────────────────────────────────
  /** Save every tile's placement in one round trip; returns the fresh list. */
  saveLayout: (locationId: string, nodes: LayoutNode[]) =>
    apiClient
      .post<RestaurantTable[]>(`/v1/tables/layout`, { locationId, nodes })
      .then((r) => r.data),

  // ── Availability ──────────────────────────────────────────────────────
  /** 400s if the table still has an open tab. */
  setOutOfService: (id: string, outOfService: boolean, note?: string | null) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/out-of-service`, {
        outOfService,
        note,
      })
      .then((r) => r.data),

  setBookable: (id: string, bookableOnline: boolean) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/bookable`, { bookableOnline })
      .then((r) => r.data),

  // ── Current sitting ───────────────────────────────────────────────────
  setSitting: (id: string, input: SittingInput) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/sitting`, input)
      .then((r) => r.data),

  // ── QR at table ───────────────────────────────────────────────────────
  /** Mints the token the first time; called again it ROTATES (kills stickers). */
  rotateQr: (id: string) =>
    apiClient.post<RestaurantTable>(`/v1/tables/${id}/qr`, {}).then((r) => r.data),

  /** Print the customer's bill ("the check") for an open tab — unpaid. */
  printBill: (orderId: string) =>
    apiClient
      .post<{ printed: number }>(`/v1/orders/${orderId}/print-bill`, {})
      .then((r) => r.data),

  // ── Split the bill ────────────────────────────────────────────────────
  paymentSummary: (orderId: string) =>
    apiClient
      .get<PaymentSummary>(`/v1/orders/${orderId}/payments`)
      .then((r) => r.data),

  addPayment: (
    orderId: string,
    body: { amount: number; method: "CASH" | "CARD"; note?: string },
  ) =>
    apiClient
      .post<PaymentSummary>(`/v1/orders/${orderId}/payments`, body)
      .then((r) => r.data),
};

export interface PaymentSummary {
  total: number;
  paid: number;
  remaining: number;
  settled: boolean;
  payments: {
    id: string;
    amount: string | number;
    method: string;
    createdAt: string;
  }[];
}
