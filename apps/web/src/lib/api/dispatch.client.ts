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

export interface DispatchFeed {
  scope: string[];
  locations: DispatchLocationPin[];
  orders: DispatchOrderPin[];
  drivers: DispatchDriverDot[];
}

/** Location-scoped dispatch feed. Pass a locationId, or "all"/undefined. */
export async function getDispatchFeed(location?: string): Promise<DispatchFeed> {
  const res = await apiClient.get<DispatchFeed>("/v1/dispatch/feed", {
    params: location ? { location } : undefined,
  });
  return res.data;
}
