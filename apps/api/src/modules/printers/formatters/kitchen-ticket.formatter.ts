import { paymentLabelFor } from "./receipt.formatter";

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
    /**
     * Kitchen-language name, when the location prints translated tickets and
     * this product has one. The renderer prints THIS instead of `name` — it
     * is not an extra line, because a kitchen reading Chinese does not want to
     * scan past the English to find it.
     *
     * Absent for every shop that has not switched translations on, which is
     * nearly all of them.
     */
    secondLanguageName?: string | null;
    quantity: number;
    modifiers: Array<{
      name: string;
      depth?: number;
      /** Kitchen-language name, same rules as the item's. */
      secondLanguageName?: string | null;
    }>;
    notes?: string | null;
  }>;
  // Kitchen needs to know at a glance whether to expect cash at
  // handover. Mirrors the receipt's banner. See receipt.formatter.ts
  // paymentLabelFor() for the wording rules.
  paymentMethod: string | null;
  paymentStatus: string | null;
  paymentLabel: string;
  specialInstructions?: string | null;
  scheduledFor?: string | null;
  // Phase AW-26 — visitCount === 1 → NEW; otherwise running order
  // number for the kitchen banner.
  customerVisitCount?: number;
  customerVisitTag?: string;
  printedAt: string;
}

export function buildKitchenTicketPayload(
  order: any,
  customerVisitCount?: number,
  /**
   * menuItemId -> kitchen-language name. Resolved by the caller (which has
   * prisma) and empty unless the location has translations on.
   *
   * Looked up at print time rather than snapshotted onto the order line: a
   * ticket prints seconds after the order, and this way no order-write path —
   * POS, storefront, or any marketplace webhook — needs to know translations
   * exist.
   */
  kitchenNames?: Map<string, string>,
  /**
   * Modifier translations, keyed by the option's NAME rather than its id.
   *
   * An order line stores its modifiers as {name, price, quantity} with no
   * option id, and adding one would mean touching every order-write path. Name
   * is a sound key regardless: "Chips" is the same word whichever group it came
   * from, which is why the translator works on distinct names in the first
   * place.
   */
  modifierNames?: Map<string, string>,
): KitchenTicketPayload {
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
      secondLanguageName:
        (item.menuItemId && kitchenNames?.get(item.menuItemId)) || null,
      quantity: item.quantity,
      // depth carries the nesting level so the ticket can indent
      // "Make It a Meal / Fries / Garlic Mayo" instead of printing three
      // sibling lines that read as three separate things the kitchen owes.
      modifiers: (item.modifiers ?? []).map((m: any) => ({
        name: m.name,
        depth: m.depth ?? 0,
        secondLanguageName:
          modifierNames?.get(String(m.name ?? "").trim()) ?? null,
      })),
      notes: item.notes ?? null,
    })),
    paymentMethod: order.paymentMethod ?? null,
    paymentStatus: order.paymentStatus ?? null,
    paymentLabel: paymentLabelFor(order.paymentMethod, order.paymentStatus),
    specialInstructions: order.specialInstructions ?? null,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    customerVisitCount,
    customerVisitTag:
      customerVisitCount == null
        ? undefined
        : customerVisitCount <= 1
          ? "*** NEW CUSTOMER ***"
          : `*** RETURNING CUSTOMER · ORDER #${customerVisitCount} ***`,
    printedAt: new Date().toISOString(),
  };
}
