// ── Order Status Rank & Lifecycle Helpers ───────────────────────────────────
//
// A defensive, deterministic ordering of OrderStatus values. The numeric rank
// is used as a *backstop* against accidental status downgrades — the per-status
// transition whitelist (see apps/api orders/order-state-machine.ts) is the
// primary enforcement, this rank is a second line of defense and a useful
// helper for sorting/display.
//
// Base44 reference behaviour:
//   - Cancellation always overrides current status (no rank check).
//   - Downgrades to a lower-rank non-terminal status are rejected.
//   - Terminal states (COMPLETED, CANCELLED, REJECTED, FAILED) are final.

import type { OrderStatus } from "./order.types";

// Higher = further along the happy path. Terminal exception states share rank
// with their typical predecessors so a CANCELLED at rank 100 will always
// trigger via the explicit override helpers below rather than rank math.
export const STATUS_RANK: Readonly<Record<OrderStatus, number>> = Object.freeze({
  PENDING: 10,
  ACCEPTED: 20,
  PREPARING: 30,
  READY: 40,
  ASSIGNED_DRIVER: 50,
  ACCEPTED_BY_DRIVER: 60,
  OUT_FOR_DELIVERY: 70,
  DISPATCHED: 70, // legacy alias, same rank as OUT_FOR_DELIVERY
  COMPLETED: 100,
  // Exception terminals — high rank so they "absorb" anything in flight.
  // Cancellation is always allowed; rank here just keeps it from being
  // accidentally reverted by a stale platform event.
  CANCELLED: 100,
  REJECTED: 100,
  FAILED: 100,
});

export const TERMINAL_STATUSES: readonly OrderStatus[] = Object.freeze([
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "FAILED",
]);

// Statuses where staff can still cancel without going through the full chain.
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = Object.freeze([
  "PENDING",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
  "OUT_FOR_DELIVERY",
  "DISPATCHED",
]);

export function getRank(status: OrderStatus): number {
  return STATUS_RANK[status];
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isCancellation(status: OrderStatus): boolean {
  return status === "CANCELLED" || status === "REJECTED" || status === "FAILED";
}

// True if `to` is strictly forward of `from` on the happy path.
// Cancellation/rejection/failure are never "monotonic forward" — handle
// those via isCancellation() at the call site so the intent is explicit.
export function isMonotonicForward(from: OrderStatus, to: OrderStatus): boolean {
  if (isCancellation(to)) return false;
  return STATUS_RANK[to] > STATUS_RANK[from];
}

// Defensive check used by services as a backstop against bad transitions
// that slip past the per-status whitelist (e.g. a platform webhook arriving
// out of order). Cancellation always overrides.
export function assertMonotonicOrCancel(from: OrderStatus, to: OrderStatus): void {
  if (isCancellation(to)) return; // cancellation always wins
  if (isTerminal(from)) {
    throw new Error(
      `Order is in terminal state ${from}; cannot transition to ${to}`,
    );
  }
  if (STATUS_RANK[to] < STATUS_RANK[from]) {
    throw new Error(
      `Status downgrade rejected: ${from} (rank ${STATUS_RANK[from]}) → ${to} (rank ${STATUS_RANK[to]})`,
    );
  }
}
