// "Are WE still collecting the money for this order?"
//
// One definition, four consumers. It existed as four separate copies — the
// board columns, the list buckets, the Automation auto-accept hook and
// (missing entirely) the tablet auto-print hook — and every time a new payment
// method needed holding, one of them got missed. Walk-in cash was added to
// three of the four and still printed unpaid tickets, because the fourth was
// the one that actually drives the printer.
//
// If you add a payment method that WE collect for, add it here and nowhere
// else.

export interface AwaitingPaymentOrder {
  status?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  isWalkIn?: boolean | null;
}

/**
 * True while the shop is still waiting to be paid for an order it is holding.
 *
 * Such an order must not reach the kitchen: it does not auto-accept, it does
 * not auto-print, and it sits in "Waiting for payment" rather than New. The
 * moment paymentStatus flips to PAID this returns false, and the normal accept
 * + print pipeline runs with the correct paid status on the ticket.
 *
 * Deliberately NOT included:
 *  • phone COLLECTION cash — the customer is not in the shop, so the kitchen
 *    has to start cooking; the money is taken at handover.
 *  • marketplace orders — Uber/Deliveroo/Just Eat settle on their own side and
 *    arrive already paid.
 *  • dine-in tabs — they run up a bill through the whole meal by design.
 */
export function isAwaitingOurPayment(o: AwaitingPaymentOrder): boolean {
  if (String(o.status ?? "").toUpperCase() !== "PENDING") return false;
  if (o.paymentStatus === "PAID") return false;
  const method = o.paymentMethod ?? "";
  return (
    method === "PAYMENT_LINK" ||
    method === "QR_CODE" ||
    // Card terminal (S700 / WisePad 3) collects now — hold until the reader
    // charge settles, same as a payment link.
    method === "CARD_TERMINAL" ||
    // Walk-in cash: the customer is at the counter and the keypad has not been
    // settled. isWalkIn is what separates this from a phone collection order,
    // which is also cash and also unpaid but must reach the kitchen at once.
    (o.isWalkIn === true && method === "CASH")
  );
}
