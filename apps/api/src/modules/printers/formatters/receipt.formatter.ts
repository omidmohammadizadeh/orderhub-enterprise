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
  specialInstructions?: string | null;
  scheduledFor?: string | null;
  printedAt: string;
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
    specialInstructions: order.specialInstructions ?? null,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    printedAt: new Date().toISOString(),
  };
}
