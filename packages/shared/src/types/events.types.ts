// ─────────────────────────────────────────────────────────
// Socket.IO event contracts — shared between the NestJS gateway
// and the Next.js Socket.IO client so both sides stay in sync.
// ─────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  // A new order arrived at the location
  "order:new": (payload: OrderEventPayload) => void;
  // An order's status changed
  "order:updated": (payload: OrderEventPayload) => void;
  // An order was cancelled
  "order:cancelled": (payload: OrderCancelledPayload) => void;
  // Kitchen display: a ticket was bumped (completed by cook)
  "kds:bump": (payload: KdsBumpPayload) => void;
  // KDS: new order tickets created
  "kds:order:new": (payload: KdsOrderNewPayload) => void;
  // KDS: new ticket created on a screen
  "kds:ticket:new": (payload: KdsTicketPayload) => void;
  // KDS: ticket bumped via worker
  "kds:ticket:bumped": (payload: KdsTicketBumpedPayload) => void;
  // KDS: ticket recalled (un-bumped)
  "kds:ticket:recalled": (payload: KdsTicketRecalledPayload) => void;
  // Integration went offline / came back
  "integration:status": (payload: IntegrationStatusPayload) => void;
  // A printer changed online status
  "printer:status": (payload: PrinterStatusPayload) => void;
  // A print job changed status
  "print:job": (payload: PrintJobEventPayload) => void;
  // Store status changed (emergency close, pause, resume)
  "store:emergency-closed": (payload: StoreStatusPayload) => void;
  "store:status-changed": (payload: StoreStatusPayload) => void;
  // Dispatch events
  "dispatch:driver:assigned": (payload: DriverAssignedPayload) => void;
  "dispatch:assignment:updated": (payload: DriverAssignedPayload) => void;
  "dispatch:tracking:update": (payload: TrackingUpdatePayload) => void;
}

export interface ClientToServerEvents {
  "room:join": (locationId: string) => void;
  "room:leave": (locationId: string) => void;
  // Staff accepts an order from the dashboard
  "order:accept": (orderId: string) => void;
  // Staff bumps a KDS ticket
  "kds:bump": (ticketId: string) => void;
}

export interface OrderEventPayload {
  orderId: string;
  tenantId: string;
  locationId: string;
  platform: string;
  orderSource: string;
  fulfillmentType: string;
  displayId: string | null;
  status: string;
  total: number;
  itemCount: number;
  customerName: string;
  scheduledFor: string | null;
  createdAt: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  locationId: string;
  reason: string | null;
  cancelledAt: string;
}

export interface KdsBumpPayload {
  ticketId: string;
  orderId: string;
  kdsScreenId: string;
  bumpedAt: string;
}

export interface IntegrationStatusPayload {
  locationId: string;
  platform: string;
  status: "ACTIVE" | "INACTIVE" | "ERROR";
  message?: string;
}

export interface PrinterStatusPayload {
  printerId: string;
  locationId: string;
  isOnline: boolean;
}

export interface PrintJobEventPayload {
  jobId: string;
  orderId: string | null;
  locationId: string;
  type: string;
  status: string;
  printedAt: string | null;
}

export interface KdsOrderNewPayload {
  orderId: string;
  screenIds?: string[];
  displayId?: string | null;
  platform?: string;
  fulfillmentType?: string;
  ticket?: Record<string, unknown> | null;
}

export interface KdsTicketBumpedPayload {
  orderId: string;
  bumpedAt: string | null;
  screenId?: string;
}

export interface KdsTicketPayload {
  id: string;
  kdsScreenId: string;
  orderId: string;
  createdAt: string;
  bumpedAt: string | null;
  recalledAt: string | null;
  [key: string]: unknown;
}

export interface KdsTicketRecalledPayload {
  screenId: string;
  orderId: string;
}

export interface StoreStatusPayload {
  locationId: string;
  locationName: string;
  status: string;
  reason?: string;
}

export interface DriverAssignedPayload {
  orderId: string;
  displayId: string;
  driverId: string;
  driverName: string;
  status: string;
}

export interface TrackingUpdatePayload {
  orderId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}
