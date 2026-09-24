/**
 * What an order is CALLED when a human looks at it.
 *
 * The board, the phone line and the caller popup all have to say the same
 * thing — "order 41" on one screen and "…a3f9c2" on another is how staff lose
 * track of which order they are holding. Three sources, in the order a person
 * would recognise them: the platform's own id if it came from a marketplace,
 * our sequential number if it's ours, and the tail of the internal id only
 * when neither exists.
 */
export function boardReference(order: {
  displayId?: string | null;
  orderNumber?: number | string | null;
  id?: string | null;
}): string {
  if (order.displayId) return String(order.displayId);
  if (order.orderNumber != null && order.orderNumber !== "") {
    return String(order.orderNumber);
  }
  return String(order.id ?? "").slice(-6);
}
