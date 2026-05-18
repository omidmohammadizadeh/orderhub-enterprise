export interface KitchenTicketPayload {
  type: "KITCHEN_TICKET";
  orderId: string;
  displayId: string | null;
  platform: string;
  orderSource: string;
  fulfillmentType: string;
  customerName: string;
  items: Array<{
    name: string;
    quantity: number;
    modifiers: Array<{ name: string }>;
    notes?: string | null;
  }>;
  specialInstructions?: string | null;
  scheduledFor?: string | null;
  printedAt: string;
}

export function buildKitchenTicketPayload(order: any): KitchenTicketPayload {
  const customer = order.customerInfo as Record<string, any>;

  return {
    type: "KITCHEN_TICKET",
    orderId: order.id,
    displayId: order.displayId ?? null,
    platform: order.platform,
    orderSource: order.orderSource,
    fulfillmentType: order.fulfillmentType,
    customerName: customer?.name ?? "",
    items: (order.items ?? []).map((item: any) => ({
      name: item.name,
      quantity: item.quantity,
      modifiers: (item.modifiers ?? []).map((m: any) => ({ name: m.name })),
      notes: item.notes ?? null,
    })),
    specialInstructions: order.specialInstructions ?? null,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    printedAt: new Date().toISOString(),
  };
}
