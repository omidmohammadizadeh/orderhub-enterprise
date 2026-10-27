import type { FulfillmentType, OrderStatus, OrderStatusPayload } from "./api";

export function money(amount: number | string | null | undefined, currency?: string | null): string {
  const n = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "GBP" }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

export function time(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time(iso)}`;
}

const DELIVERED_BY_SOMEONE: FulfillmentType[] = ["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER"];
export const isDelivery = (f: FulfillmentType) => DELIVERED_BY_SOMEONE.includes(f);

export const TERMINAL: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"];
export const isFinished = (s: OrderStatus) => TERMINAL.includes(s);
export const isFailed = (s: OrderStatus) => s === "CANCELLED" || s === "REJECTED" || s === "FAILED";

/** The step list the tracker draws, and how far along the order is. */
export function progress(o: OrderStatusPayload): { steps: string[]; current: number } {
  const delivery = isDelivery(o.fulfillmentType);
  const steps = delivery
    ? ["Order sent", "Accepted", "Being prepared", "On its way", "Delivered"]
    : ["Order sent", "Accepted", "Being prepared", "Ready to collect", "Collected"];
  const at: Record<OrderStatus, number> = {
    PENDING: 0,
    ACCEPTED: 1,
    PREPARING: 2,
    READY: delivery ? 2 : 3,
    PENDING_DISPATCH: 2,
    ASSIGNED_DRIVER: 2,
    ACCEPTED_BY_DRIVER: 2,
    RIDER_ARRIVED: 3,
    OUT_FOR_DELIVERY: 3,
    DISPATCHED: 3,
    COMPLETED: 4,
    CANCELLED: 0,
    REJECTED: 0,
    FAILED: 0,
  };
  return { steps, current: at[o.status] ?? 0 };
}

export function headline(o: OrderStatusPayload): string {
  if (o.status === "PENDING" && o.paymentMethod === "CARD" && o.paymentStatus === "PENDING") return "Waiting for payment";
  switch (o.status) {
    case "PENDING":
      return "Waiting for the restaurant";
    case "ACCEPTED":
      return "Order accepted";
    case "PREPARING":
      return "Your food is being prepared";
    case "READY":
      return isDelivery(o.fulfillmentType) ? "Packed and waiting for a driver" : "Ready to collect";
    case "PENDING_DISPATCH":
    case "ASSIGNED_DRIVER":
    case "ACCEPTED_BY_DRIVER":
      return "Finding your driver";
    case "RIDER_ARRIVED":
      return "Your driver is collecting it";
    case "OUT_FOR_DELIVERY":
    case "DISPATCHED":
      return "On its way";
    case "COMPLETED":
      return isDelivery(o.fulfillmentType) ? "Delivered — enjoy!" : "Collected — enjoy!";
    case "CANCELLED":
      return "Order cancelled";
    case "REJECTED":
      return "The restaurant couldn't take this order";
    case "FAILED":
      return "Something went wrong with this order";
  }
}

export function orderLabel(o: OrderStatusPayload): string {
  return o.displayId ? `#${o.displayId}` : o.orderNumber ? `#${o.orderNumber}` : "";
}
