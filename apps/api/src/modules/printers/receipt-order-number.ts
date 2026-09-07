/**
 * The number a receipt shows.
 *
 * A phone order's customer was TOLD a number — the sequential one the line
 * looks orders up by — and the receipt must say the same thing, or the two
 * halves of the shop cannot talk about the same order. Every other channel
 * keeps the short display code it always had.
 */
export function receiptOrderNumber(order: {
  orderSource?: string | null;
  orderNumber?: number | string | null;
  displayId?: string | null;
}): string | number | null {
  if (String(order?.orderSource ?? '') === 'VOICE')
    return order.orderNumber ?? order.displayId ?? null;
  return order.displayId ?? order.orderNumber ?? null;
}
