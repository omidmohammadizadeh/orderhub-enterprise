import { BadRequestException } from "@nestjs/common";
import type { OrderStatus } from "@orderhub/database";

// Valid transitions from each status.
// The machine is monotonic — once an order reaches a terminal state
// (COMPLETED, CANCELLED, REJECTED) it cannot be moved.
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["DISPATCHED", "COMPLETED", "CANCELLED"],
  DISPATCHED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

const TERMINAL_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (TERMINAL_STATUSES.includes(from)) {
    throw new BadRequestException(
      `Order is in a terminal state (${from}) and cannot be changed`,
    );
  }
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Invalid status transition: ${from} → ${to}. Allowed: ${VALID_TRANSITIONS[from]?.join(", ") || "none"}`,
    );
  }
}

// Returns the timestamp field name for a given status transition
export function getTimestampField(
  to: OrderStatus,
): keyof TimestampFields | null {
  const map: Partial<Record<OrderStatus, keyof TimestampFields>> = {
    ACCEPTED: "acceptedAt",
    PREPARING: "preparingAt",
    READY: "readyAt",
    DISPATCHED: "outForDeliveryAt",
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
