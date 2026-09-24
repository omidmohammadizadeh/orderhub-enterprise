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
  // KDS: an item line on a ticket was marked done / undone
  "kds:item:state": (payload: KdsItemStatePayload) => void;
  // KDS: tickets voided (order cancelled) — screens drop them
  "kds:ticket:void": (payload: KdsTicketVoidPayload) => void;
  // KDS: an order's items changed (POS edit) — screens re-fetch + flag it
  "kds:order:updated": (payload: KdsOrderUpdatedPayload) => void;
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
  // Landline caller-ID: the shop's phone is ringing (from the Comet USB
  // reader via the caller-ID hub tablet). POS tablets pop the caller card.
  "callerid:ring": (payload: CallerIdRingPayload) => void;
}

/**
 * One order, as the caller popup shows it.
 *
 * Deliberately flat and already formatted where it can be: the popup appears
 * while a phone is ringing and staff read it in about two seconds, so nothing
 * on it should need a second request to become legible.
 */
export interface CallerIdOrderSummary {
  id: string;
  /** What the board calls it, so staff can shout the same thing. */
  reference: string;
  status: string;
  /** ISO. */
  placedAt: string;
  total: number;
  currency: string;
  fulfillmentType: string;
  itemCount: number;
  /** "2× Margherita, Garlic Bread" — enough to recognise the order by. */
  summary: string;
}

export interface CallerIdRingPayload {
  locationId: string;
  /** Raw number as reported by the caller-ID unit. */
  phone: string;
  at: string; // ISO timestamp
  /** Known-customer match (by phone across past orders), null for new callers. */
  match: null | {
    name: string;
    orders: number;
    email: string | null;
    addresses: Array<{
      line1: string;
      line2: string | null;
      city: string | null;
      postcode: string | null;
    }>;
    /**
     * What this customer is worth, over the same window the order count uses.
     * Null when the orders carried no totals.
     */
    lifetimeSpend: number | null;
    currency: string | null;
    /** ISO. When they first and last ordered — "a regular" vs "one order, once". */
    firstOrderAt: string | null;
    lastOrderAt: string | null;
    /**
     * An order they have ALREADY placed today at the ringing shop that is not
     * finished yet. This is nearly always why a customer rings back — "where is
     * it?", "can you add chips?" — so it outranks everything else on the card.
     */
    openOrder: CallerIdOrderSummary | null;
    /**
     * Their most recent FINISHED order at the ringing shop, for "the usual".
     * Scoped to the shop on purpose: repeating it loads that shop's menu.
     */
    lastOrder: CallerIdOrderSummary | null;
  };
}

export interface ClientToServerEvents {
  "room:join": (locationId: string) => void;
  "room:leave": (locationId: string) => void;
  // The "All locations" board has no single locationId to join — this asks
  // the server to join every location the caller is actually allowed to see
  // (server-resolved, same access rule as the REST orders endpoint), so
  // that view gets real-time pushes too instead of a 60s-only poll.
  "room:join-all": () => void;
  "room:leave-all": () => void;
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

export interface KdsItemStatePayload {
  screenId: string;
  orderId: string;
  orderItemId: string;
  done: boolean;
}

export interface KdsTicketVoidPayload {
  orderId: string;
  reason?: string;
}

export interface KdsOrderUpdatedPayload {
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
