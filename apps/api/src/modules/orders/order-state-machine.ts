import { BadRequestException } from "@nestjs/common";
import type { OrderStatus } from "@orderhub/database";
import { assertMonotonicOrCancel, isCancellation } from "@orderhub/shared";

// ── Order State Machine ──────────────────────────────────────────────────────
//
// The PRIMARY enforcement: an explicit per-status whitelist of allowed next
// states. This is more precise than rank-based ordering because it lets us
// model e.g. "READY can go to ASSIGNED_DRIVER OR straight to COMPLETED for
// collection orders" without a dedicated branch.
//
// The SECONDARY defense: STATUS_RANK / assertMonotonicOrCancel from
// @orderhub/shared catches anything that slips past (e.g. a stale webhook
// trying to revert state). Cancellation/rejection/failure are ALWAYS allowed
// from any non-terminal state.
//
// Lifecycle reference (Base44 parity):
//   PENDING → ACCEPTED → PREPARING → READY
//                                 ↓
//                         (delivery)              (collection)
//                                 ↓                       ↓
//                         ASSIGNED_DRIVER             COMPLETED
//                                 ↓
//                       ACCEPTED_BY_DRIVER
//                                 ↓
//                       OUT_FOR_DELIVERY
//                                 ↓
//                            COMPLETED
//
// DISPATCHED is a legacy alias for OUT_FOR_DELIVERY kept for back-compat with
// older outbox events, integration adapters, and webhook payloads. New code
// emits OUT_FOR_DELIVERY but accepts DISPATCHED as a synonym.

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "CANCELLED", "FAILED"],
  ACCEPTED: ["PREPARING", "CANCELLED", "FAILED"],
  PREPARING: ["READY", "CANCELLED", "FAILED"],
  READY: [
    // Collection: jump straight to COMPLETED on customer pickup.
    "COMPLETED",
    // Delivery (in-house): hand off to driver flow.
    "ASSIGNED_DRIVER",
    // Delivery (3rd-party): pushed to Uber Direct / Stuart / JET — awaiting driver accept.
    "PENDING_DISPATCH",
    // Legacy direct dispatch (no driver assignment step).
    "OUT_FOR_DELIVERY",
    "DISPATCHED",
    "CANCELLED",
    "FAILED",
  ],
  PENDING_DISPATCH: [
    "ASSIGNED_DRIVER",
    "ACCEPTED_BY_DRIVER",
    "OUT_FOR_DELIVERY",
    "DISPATCHED",
    "CANCELLED",
    "FAILED",
  ],
  ASSIGNED_DRIVER: [
    "ACCEPTED_BY_DRIVER",
    "RIDER_ARRIVED",     // staff can skip ACCEPTED if rider walks in unannounced
    "OUT_FOR_DELIVERY",  // some flows skip the driver-accept step
    "DISPATCHED",
    "CANCELLED",
    "FAILED",
  ],
  ACCEPTED_BY_DRIVER: [
    "RIDER_ARRIVED",     // canonical happy path for platform delivery
    "OUT_FOR_DELIVERY",  // skip-ahead for couriers who never check in
    "DISPATCHED",
    "CANCELLED",
    "FAILED",
  ],
  RIDER_ARRIVED: [
    "OUT_FOR_DELIVERY",
    "DISPATCHED",
    "CANCELLED",
    "FAILED",
  ],
  OUT_FOR_DELIVERY: ["COMPLETED", "CANCELLED", "FAILED"],
  DISPATCHED: ["COMPLETED", "CANCELLED", "FAILED"], // legacy
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
  FAILED: [],
};

const TERMINAL_STATUSES: OrderStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "FAILED",
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  // Cancellation/rejection/failure are always permitted from any
  // non-terminal state — staff/system can abort at any point.
  if (
    !TERMINAL_STATUSES.includes(from) &&
    isCancellation(to as OrderStatus)
  ) {
    return true;
  }
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (TERMINAL_STATUSES.includes(from)) {
    throw new BadRequestException(
      `Order is in a terminal state (${from}) and cannot be changed`,
    );
  }
  // Rank-based backstop. Throws on monotonic violation; returns silently for
  // cancellations (which are handled by the whitelist below).
  try {
    assertMonotonicOrCancel(from as OrderStatus, to as OrderStatus);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Invalid status transition: ${from} → ${to}. Allowed: ${VALID_TRANSITIONS[from]?.join(", ") || "none"}`,
    );
  }
}

// Returns the timestamp field name for a given status transition. Used by
// OrdersService.updateStatus to stamp the corresponding ...At column.
//
// ASSIGNED_DRIVER and ACCEPTED_BY_DRIVER do not have dedicated columns on
// Order — the DriverAssignment relation owns those timestamps. The Order
// row only records the final outForDeliveryAt / deliveredAt.
export function getTimestampField(
  to: OrderStatus,
): keyof TimestampFields | null {
  const map: Partial<Record<OrderStatus, keyof TimestampFields>> = {
    ACCEPTED: "acceptedAt",
    PREPARING: "preparingAt",
    READY: "readyAt",
    // RIDER_ARRIVED does not have its own column on Order — the audit-log
    // entry written by OrdersService is the source of truth for "when did
    // the courier turn up at the shop", and the timestamp can be read from
    // there if/when the operator wants courier punctuality analytics.
    OUT_FOR_DELIVERY: "outForDeliveryAt",
    DISPATCHED: "outForDeliveryAt", // legacy alias
    COMPLETED: "deliveredAt",
    CANCELLED: "cancelledAt",
  };
  return map[to] ?? null;
}

interface TimestampFields {
  acceptedAt: Date;
  preparingAt: Date;
  readyAt: Date;
  outForDeliveryAt: Date;
  deliveredAt: Date;
  cancelledAt: Date;
}
