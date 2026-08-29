import { apiClient } from "./client";

// Phase AX — Dispatch console feed. Mirrors the API's DispatchService shapes.

export type DispatchOrderStatus =
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "PENDING_DISPATCH"
  | "ASSIGNED_DRIVER"
  | "ACCEPTED_BY_DRIVER"
  | "RIDER_ARRIVED"
  | "OUT_FOR_DELIVERY"
  | "DISPATCHED";

export type DriverPresenceStatus = "OFFLINE" | "ONLINE" | "ON_JOB";

export interface DispatchLocationPin {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface DispatchOrderPin {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: DispatchOrderStatus;
  platform: string;
  deliveryType: string | null;
  locationId: string;
  customerName: string | null;
  total: string;
  paymentMethod: string | null;
  lat: number | null;
  lng: number | null;
  deadlineAt: string | null;
  createdAt: string;
  done: boolean;
  assigned: boolean;
}

export interface DispatchDriverDot {
  driverId: string;
  name: string;
  status: DriverPresenceStatus;
  locationId: string | null;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  activeAssignmentId: string | null;
  lastPingAt: string | null;
}

/** A marketplace/third-party rider, plotted from the provider's own position.
 *  Not assignable — see DispatchCourierPin on the API. */
export interface DispatchCourierPin {
  orderId: string;
  ref: string | null;
  platform: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  lat: number;
  lng: number;
  seenAt: string;
  ageMinutes: number;
}

export interface DispatchFeed {
  scope: string[];
  locations: DispatchLocationPin[];
  orders: DispatchOrderPin[];
  drivers: DispatchDriverDot[];
  couriers?: DispatchCourierPin[];
}

/** Own-fleet: assign an ordered list of orders to a driver (multi-drop). */
export async function assignOrders(driverId: string, orderIds: string[]): Promise<void> {
  await apiClient.post("/v1/dispatch/assign", { driverId, orderIds });
}

export interface OnlineDriver {
  driverId: string;
  name: string;
  phone: string;
  status: DriverPresenceStatus;
  activeJobs: number;
}

/** Online own-fleet drivers for the dispatch modal (scoped to a location). */
export async function getOnlineDrivers(locationId?: string): Promise<OnlineDriver[]> {
  const res = await apiClient.get<OnlineDriver[]>("/v1/dispatch/online-drivers", {
    params: locationId ? { locationId } : undefined,
  });
  return res.data;
}

/** Pull an order back from its driver to the board. */
export async function unassignOrder(orderId: string): Promise<void> {
  await apiClient.post("/v1/dispatch/unassign", { orderId });
}

/** Location-scoped dispatch feed. Pass a locationId, or "all"/undefined. */
export async function getDispatchFeed(location?: string): Promise<DispatchFeed> {
  const res = await apiClient.get<DispatchFeed>("/v1/dispatch/feed", {
    params: location ? { location } : undefined,
  });
  return res.data;
}

// ── Operator dashboard ────────────────────────────────────────────────────────
export interface OperatorStats {
  online: number;
  busy: number;
  outForDelivery: number;
  deliveredToday: number;
  attention: number;
  failedToday: number;
}
export interface OperatorOrderRow {
  id: string;
  ref: string;
  customerName: string | null;
  status: DispatchOrderStatus;
  deadlineAt: string | null;
  minutesLate: number | null;
  driverName: string | null;
  address: string | null;
}
export type DriverAssignmentStatus =
  | "ASSIGNED"
  | "ACCEPTED"
  | "PICKED_UP"
  | "DELIVERED"
  | "CANCELLED";
export interface OperatorDriverJob {
  orderId: string;
  ref: string;
  customerName: string | null;
  status: DriverAssignmentStatus;
  sequence: number | null;
  address: string | null;
}
export interface PostcodeFee {
  postcode: string;
  fee: number;
}
export interface OperatorDriverRow {
  id: string;
  name: string;
  status: DriverPresenceStatus;
  lastPingAt: string | null;
  activeJobs: OperatorDriverJob[];
  delivered: number;
  cashTotal: string;
  cardTotal: string;
  total: string;
  homeLocationId: string | null;
  startupFee: string;
  postcodeFees: PostcodeFee[];
  earningToday: string;
}
export interface OperatorFailedRow {
  id: string;
  ref: string;
  customerName: string | null;
  status: string;
  reason: string | null;
  at: string;
}
export interface OperatorDashboard {
  scope: string[];
  stats: OperatorStats;
  attention: OperatorOrderRow[];
  outForDelivery: OperatorOrderRow[];
  drivers: OperatorDriverRow[];
  recentFailed: OperatorFailedRow[];
}

export async function getOperatorDashboard(location?: string): Promise<OperatorDashboard> {
  const res = await apiClient.get<OperatorDashboard>("/v1/dispatch/operator", {
    params: location ? { location } : undefined,
  });
  return res.data;
}

/** Move an order from its current driver to another: pull it back, then assign. */
export async function reassignOrder(orderId: string, driverId: string): Promise<void> {
  await unassignOrder(orderId);
  await assignOrders(driverId, [orderId]);
}

// ── Driver pay + cash-up (Phase BG) ──────────────────────────────────────────
export interface CashUpView {
  driverId: string;
  driverName: string;
  periodStart: string | null;
  periodEnd: string;
  outstanding: boolean;
  startupFee: number;
  deliveries: number;
  cashOrders: number;
  cashCollected: number;
  cardOrders: number;
  cardCollected: number;
  daysWorked: number;
  startupFeeTotal: number;
  deliveryFeeTotal: number;
  driverEarning: number;
  cashHandover: number; // negative = restaurant owes the driver
}

export async function updateDriverEarnings(
  driverId: string,
  body: { locationId?: string | null; startupFee?: number; postcodeFees?: PostcodeFee[] },
): Promise<void> {
  await apiClient.patch(`/v1/dispatch/drivers/${driverId}/earnings`, body);
}

export async function getDriverCashUp(
  driverId: string,
  range?: { from?: string; to?: string },
): Promise<CashUpView> {
  const res = await apiClient.get<CashUpView>(`/v1/dispatch/drivers/${driverId}/cashup`, {
    params: range && (range.from || range.to) ? range : undefined,
  });
  return res.data;
}

export async function settleDriverCashUp(driverId: string): Promise<void> {
  await apiClient.post(`/v1/dispatch/drivers/${driverId}/cashup`);
}

// ── Operator ↔ driver chat ────────────────────────────────────────────────────
export interface ChatMessageDto {
  id: string;
  senderType: "OPERATOR" | "DRIVER" | "CUSTOMER";
  senderName: string | null;
  body: string;
  createdAt: string;
}
export interface ChatThread {
  driverId: string;
  name: string;
  status: DriverPresenceStatus;
  lastBody: string | null;
  lastAt: string | null;
  unread: number;
}
export async function getChatThreads(locationId?: string): Promise<ChatThread[]> {
  // Narrows to one shop. Omitted, the API returns every driver across the
  // locations the caller can reach — never the whole tenant.
  const res = await apiClient.get<ChatThread[]>("/v1/chat/threads", {
    params: locationId ? { locationId } : undefined,
  });
  return res.data;
}
export async function getDriverChat(driverId: string): Promise<ChatMessageDto[]> {
  const res = await apiClient.get<{ messages: ChatMessageDto[] }>(`/v1/chat/driver/${driverId}`);
  return res.data.messages;
}
export async function sendDriverChat(driverId: string, body: string): Promise<void> {
  await apiClient.post(`/v1/chat/driver/${driverId}`, { body });
}
