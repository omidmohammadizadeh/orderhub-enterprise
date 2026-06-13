// Generates the structured payload stored in PrintJob.payload for receipts.
// The print processor translates this to ESC/POS bytes or a cloud print job.

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers: Array<{ name: string; price: number }>;
  notes?: string | null;
}

export interface ReceiptPayload {
  type: "RECEIPT";
  orderId: string;
  displayId: string | null;
  platform: string;
  orderSource: string;
  fulfillmentType: string;
  customerName: string;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  items: ReceiptLine[];
  subtotal: number;
  taxAmount: number;
  deliveryFee: number;
  discount: number;
  total: number;
  // Raw payment columns + a pre-rendered banner the printer agent
  // drops onto the ticket. We render server-side so every printer
  // model gets the same wording without each agent reimplementing the
  // mapping. See paymentLabelFor() for the rules.
  paymentMethod: string | null;
  paymentStatus: string | null;
  paymentLabel: string;
  specialInstructions?: string | null;
  scheduledFor?: string | null;
  printedAt: string;
}

/**
 * Big, unmissable banner the kitchen reads at a glance:
 *   • CARD authorised/captured → "PAID (CARD)" — money is in the
 *     account already, no cash needed at handover.
 *   • CASH paid up-front (POS) → "PAID (CASH)"
 *   • CASH owed at handover    → "CASH ON HANDOVER" — collect at the
 *     door / counter.
 *   • Marketplace pre-paid     → "PAID"
 *   • Refunded                 → "REFUNDED"
 *   • Anything else            → "UNPAID"
 */
export function paymentLabelFor(
  method: string | null | undefined,
  status: string | null | undefined,
): string {
  if (method === "CARD") {
    if (status === "PAID" || status === "AUTHORIZED") return "*** PAID (CARD) ***";
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED")
      return "*** REFUNDED ***";
    return "*** CARD NOT PAID ***";
  }
  if (method === "CASH") {
    if (status === "PAID") return "*** PAID (CASH) ***";
    return "*** CASH ON HANDOVER ***";
  }
  // Marketplace orders (Uber/Deliveroo/Just Eat) come pre-paid; just
  // honour whatever the platform reported.
  if (status === "PAID") return "*** PAID ***";
  return "*** UNPAID ***";
}

export function buildReceiptPayload(order: any): ReceiptPayload {
  const customer = order.customerInfo as Record<string, any>;
  const address = order.deliveryAddress as Record<string, any> | null;

  return {
    type: "RECEIPT",
    orderId: order.id,
    displayId: order.displayId ?? null,
    platform: order.platform,
    orderSource: order.orderSource,
    fulfillmentType: order.fulfillmentType,
    customerName: customer?.name ?? "",
    customerPhone: customer?.phone ?? null,
    deliveryAddress: address
      ? [address.line1, address.line2, address.city, address.postcode]
          .filter(Boolean)
          .join(", ")
      : null,
    items: (order.items ?? []).map((item: any) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      totalPrice: Number(item.totalPrice),
      modifiers: (item.modifiers ?? []).map((m: any) => ({
        name: m.name,
        price: Number(m.price ?? 0),
      })),
      notes: item.notes ?? null,
    })),
    subtotal: Number(order.subtotal),
    taxAmount: Number(order.taxAmount),
    deliveryFee: Number(order.deliveryFee),
    discount: Number(order.discount),
    total: Number(order.total),
    paymentMethod: order.paymentMethod ?? null,
    paymentStatus: order.paymentStatus ?? null,
    paymentLabel: paymentLabelFor(order.paymentMethod, order.paymentStatus),
    specialInstructions: order.specialInstructions ?? null,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    printedAt: new Date().toISOString(),
  };
}
