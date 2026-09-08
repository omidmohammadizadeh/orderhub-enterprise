/**
 * The number a receipt shows.
 *
 * One rule for every channel: what the orders board shows — the short display
 * code, else the sequential number. A phone order used to be the exception,
 * printing its sequential number because that was what the caller had been
 * told; the caller is now told the board's reference too, so the receipt,
 * the board and the phone all say the same thing. The sequential number
 * stays on the order and is still searchable.
 */
export function receiptOrderNumber(order: {
  orderSource?: string | null;
  orderNumber?: number | string | null;
  displayId?: string | null;
}): string | number | null {
  return order?.displayId ?? order?.orderNumber ?? null;
}
