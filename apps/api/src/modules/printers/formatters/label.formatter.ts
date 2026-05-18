export interface LabelPayload {
  type: "LABEL";
  orderId: string;
  displayId: string | null;
  itemName: string;
  itemIndex: number;
  totalItems: number;
  customerName: string;
  fulfillmentType: string;
  scheduledFor?: string | null;
  printedAt: string;
}

export function buildLabelPayloads(order: any): LabelPayload[] {
  const customer = order.customerInfo as Record<string, any>;
  const items: any[] = order.items ?? [];
  const allItems = items.flatMap((item) =>
    Array.from({ length: item.quantity }, (_, i) => ({ ...item, _index: i })),
  );

  return allItems.map((item, index) => ({
    type: "LABEL",
    orderId: order.id,
    displayId: order.displayId ?? null,
    itemName: item.name,
    itemIndex: index + 1,
    totalItems: allItems.length,
    customerName: customer?.name ?? "",
    fulfillmentType: order.fulfillmentType,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    printedAt: new Date().toISOString(),
  }));
}
