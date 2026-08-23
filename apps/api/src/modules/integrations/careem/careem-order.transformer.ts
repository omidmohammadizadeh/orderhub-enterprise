import {
  CanonicalOrderSchema,
  type CanonicalOrder,
  type OrderItem,
} from "@orderhub/shared";

// Phase CA-2 — Careem order → CanonicalOrder.
//
// ── What this is built from ─────────────────────────────────────────────────
//
// Careem's documentation, which for orders is unusually good: complete example
// payloads for ORDER_CREATED and ORDER_STATUS_UPDATED, a full OrderItem schema,
// and a pricing section that works an example through to a total step by step.
// The tests reproduce that worked example exactly — if our arithmetic and
// theirs ever disagree, a test fails rather than a customer being charged the
// wrong amount.
//
// Still to be checked against a real order: nothing about the SHAPE is
// guessed, but Careem is the third marketplace whose docs have drifted from
// their payloads, so `metadata.careemRaw` keeps the original body on the Order
// for exactly that comparison.
//
// ── The three things that make this different from the other marketplaces ───
//
// 1. ITEMS CARRY NO NAMES. An order line is `{ id, quantity, prices }` and
//    nothing else — the id is the catalog id WE published. Names are resolved
//    by the caller from our own menu and passed in; without them a ticket
//    prints a row of UUIDs. Same trap as JET.
//
// 2. PRICES ARE TAX-INCLUSIVE AND DISCOUNTS ARE ALREADY APPLIED. Careem's
//    `total_taxable_price` is what the customer actually pays. We do not
//    recompute it — we reproduce their formula and assert it matches, then use
//    THEIR number. Deriving our own total from parts is how a marketplace
//    order ends up a few fils out and nobody notices for a month.
//
// 3. CUSTOMER DETAILS ARRIVE ONLY FOR SELF-DELIVERY. For `delivery_type:
//    "careem"` the customer block is present but blank — their own example
//    shows empty strings and `phone_number: 0`. That is not missing data to
//    warn about; it is Careem keeping their customer's details, and the
//    resulting order legitimately has no address.

/** An order as Careem sends it. Only the fields we read are typed. */
export interface CareemOrder {
  id: number | string;
  status?: string;
  merchant_pay_type?: string;
  delivery_type?: "careem" | "merchant" | string;
  delivery?: {
    type?: string;
    delivery_mode?: string;
    schedule_detail?: { time_slot?: { start?: string; end?: string } };
  };
  branch?: { id?: string; name?: string; brand_id?: string };
  notes?: string;
  price?: CareemOrderPrice;
  customer?: {
    name?: string;
    phone_number?: number | string;
    payment_type?: string;
    address?: {
      name?: string;
      number?: string;
      building?: string;
      street?: string;
      area?: string;
      city?: string;
      note?: string;
      location?: { lat?: string; lng?: string };
    };
  };
  cash_in?: number;
  items?: CareemOrderItem[];
  is_scheduled?: boolean;
  prepare_time?: string;
  created_at?: string;
  cancellation_reason?: string;
  metadata?: {
    order_instructions?: {
      merchant_notes?: string | null;
      merchant_instructions?: Array<{
        label?: string;
        name_localized?: { en?: string; ar?: string };
      }> | null;
    };
  };
}

export interface CareemOrderPrice {
  original_total_price?: number;
  total_taxable_price?: number;
  tax_percentage?: number;
  delivery_fee?: number;
  service_fee?: number;
  careem_discount_amount?: number;
  merchant_discount_amount?: number;
  careem_promo_amount?: number;
  merchant_promo_amount?: number;
  free_delivery_discount_value?: number;
  promo_code?: string;
}

export interface CareemOrderItem {
  id?: string;
  quantity?: number;
  unit_price?: number;
  item_price?: number;
  total_price?: number;
  discount?: number;
  notes?: string;
  groups?: CareemOrderGroup[];
}

export interface CareemOrderGroup {
  id?: string;
  options?: Array<{
    id?: string;
    quantity?: number;
    total_price?: number;
    /** Options can carry their own groups — Careem supports nested modifiers
     *  natively, which most marketplaces do not. */
    groups?: CareemOrderGroup[];
  }>;
}

/** Our menu, keyed by the ids we published to Careem. */
export interface CareemNameLookup {
  item(id: string): string | undefined;
  option(id: string): string | undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Careem's documented total, recomputed from its parts.
 *
 * Their formula, in their order:
 *   sub_total  = original + tax − (merchant_discount + careem_discount)
 *                        − (merchant_promo + careem_promo)
 *   total      = sub_total + delivery_fee + service_fee
 *
 * Exported so a test can hold it against the worked example in their docs.
 * Used only to CHECK `total_taxable_price`, never to replace it.
 */
export function computeCareemTotal(price: CareemOrderPrice): number {
  const original = Number(price.original_total_price ?? 0);
  const taxPct = Number(price.tax_percentage ?? 0);
  const afterTax = original + (original * taxPct) / 100;
  const promotions =
    Number(price.merchant_discount_amount ?? 0) +
    Number(price.careem_discount_amount ?? 0);
  const promoCodes =
    Number(price.merchant_promo_amount ?? 0) +
    Number(price.careem_promo_amount ?? 0);
  const subTotal = afterTax - promotions - promoCodes;
  return round2(
    subTotal + Number(price.delivery_fee ?? 0) + Number(price.service_fee ?? 0),
  );
}

/** Every discount on the order, as one number for our own reporting. */
export function careemTotalDiscount(price: CareemOrderPrice): number {
  return round2(
    Number(price.merchant_discount_amount ?? 0) +
      Number(price.careem_discount_amount ?? 0) +
      Number(price.merchant_promo_amount ?? 0) +
      Number(price.careem_promo_amount ?? 0),
  );
}

/**
 * Flatten Careem's nested option tree into our modifier list.
 *
 * Options can contain groups which contain more options, arbitrarily deep.
 * Our OrderItem.modifiers is flat, so depth is carried on each entry and the
 * kitchen ticket indents by it — the same shape the nested-modifier work
 * already established for the storefront.
 */
export function flattenCareemModifiers(
  groups: CareemOrderGroup[] | undefined,
  names: CareemNameLookup,
  depth = 0,
): Array<{ name: string; price: number; quantity: number; depth: number }> {
  const out: Array<{
    name: string;
    price: number;
    quantity: number;
    depth: number;
  }> = [];
  for (const group of groups ?? []) {
    for (const option of group.options ?? []) {
      out.push({
        // An id we can't resolve still prints — as the id — because a ticket
        // missing a line entirely is worse than one with an ugly line.
        name: names.option(String(option.id ?? "")) ?? String(option.id ?? "?"),
        price: round2(Number(option.total_price ?? 0)),
        quantity: Math.max(1, Number(option.quantity ?? 1)),
        depth,
      });
      if (option.groups?.length) {
        out.push(...flattenCareemModifiers(option.groups, names, depth + 1));
      }
    }
  }
  return out;
}

/** Careem's phone numbers arrive as NUMBERS, and 0 means "not provided". */
function phone(raw: number | string | undefined): string | undefined {
  const s = String(raw ?? "").trim();
  return !s || s === "0" ? undefined : s;
}

/** Their address is a set of parts, any of which may be blank. */
function addressLine(a: CareemOrder["customer"] extends infer C ? any : never) {
  return [a?.number, a?.building, a?.street].map((p) => String(p ?? "").trim()).filter(Boolean).join(", ");
}

export function transformCareemOrder(
  order: CareemOrder,
  names: CareemNameLookup,
  ctx: { country?: string } = {},
): CanonicalOrder {
  const price = order.price ?? {};
  const selfDelivery = order.delivery_type === "merchant";
  const addr = order.customer?.address;

  const items: OrderItem[] = (order.items ?? []).map((line) => {
    const quantity = Math.max(1, Number(line.quantity ?? 1));
    return {
      name: names.item(String(line.id ?? "")) ?? String(line.id ?? "Unknown item"),
      quantity,
      // unit_price excludes options; total_price is the line as charged.
      unitPrice: round2(Number(line.unit_price ?? 0)),
      totalPrice: round2(Number(line.total_price ?? 0)),
      modifiers: flattenCareemModifiers(line.groups, names),
      ...(line.notes ? { notes: line.notes } : {}),
      // The catalog id we published — how a ticket, a KDS rule or a report
      // gets back to our own MenuItem.
      sku: String(line.id ?? ""),
    };
  });

  // Their number, not ours. computeCareemTotal only cross-checks it.
  const total = round2(Number(price.total_taxable_price ?? 0));
  const deliveryFee = round2(Number(price.delivery_fee ?? 0));
  const serviceFee = round2(Number(price.service_fee ?? 0));
  const discount = careemTotalDiscount(price);
  // Careem prices are tax-INCLUSIVE, so tax is a component of the total rather
  // than something added to it. Reported for the books, never re-added.
  const original = round2(Number(price.original_total_price ?? 0));
  const taxAmount = round2(
    (original * Number(price.tax_percentage ?? 0)) / 100,
  );

  // Whatever is left of the customer's bill once fees are taken off — our
  // "subtotal" is the goods, and Careem's total already includes the fees.
  const subtotal = round2(Math.max(0, total - deliveryFee - serviceFee));

  const instructions = [
    order.notes,
    order.metadata?.order_instructions?.merchant_notes,
    ...(order.metadata?.order_instructions?.merchant_instructions ?? []).map(
      (i) => i?.name_localized?.en ?? i?.label,
    ),
  ]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" · ");

  const scheduledStart =
    order.delivery?.schedule_detail?.time_slot?.start ?? order.prepare_time;

  return CanonicalOrderSchema.parse({
    externalId: String(order.id),
    platform: "CAREEM",
    orderSource: "CAREEM",
    integrationSource: "DIRECT",
    viaHubrise: false,
    // Careem's own courier collects, so from the kitchen's point of view it is
    // a collection. Only self-delivery makes us responsible for the journey.
    fulfillmentType: selfDelivery ? "DELIVERY" : "PLATFORM_COURIER",
    displayId: `CA-${order.id}`,
    customerInfo: {
      // Blank for Careem-delivered orders by design — they keep their
      // customer's details. Not an error, and not worth a warning.
      name: order.customer?.name?.trim() || "Careem customer",
      ...(phone(order.customer?.phone_number)
        ? { phone: phone(order.customer?.phone_number) }
        : {}),
    },
    ...(selfDelivery && addr
      ? {
          deliveryAddress: {
            line1: addressLine(addr) || addr.name || "",
            ...(addr.name ? { line2: addr.name } : {}),
            city: String(addr.city ?? ""),
            ...(addr.area ? { area: addr.area } : {}),
            country: ctx.country ?? "AE",
            ...(Number(addr.location?.lat) && Number(addr.location?.lng)
              ? {
                  coordinates: {
                    lat: Number(addr.location!.lat),
                    lng: Number(addr.location!.lng),
                  },
                }
              : {}),
          },
        }
      : {}),
    items,
    subtotal,
    taxAmount,
    deliveryFee,
    discount,
    total,
    ...(instructions ? { specialInstructions: instructions } : {}),
    ...(order.is_scheduled && scheduledStart
      ? { scheduledFor: new Date(scheduledStart) }
      : {}),
    metadata: {
      careemOrderId: order.id,
      careemBranchId: order.branch?.id ?? null,
      careemBrandId: order.branch?.brand_id ?? null,
      careemStatus: order.status ?? null,
      deliveryType: order.delivery_type ?? null,
      merchantPayType: order.merchant_pay_type ?? null,
      customerPaymentType: order.customer?.payment_type ?? null,
      // Non-zero means the driver collects this much in cash. Zero means paid.
      cashIn: Number(order.cash_in ?? 0),
      serviceFee,
      promoCode: price.promo_code ?? null,
      // Kept so a real order can be diffed against the documented shape this
      // transformer was written from.
      careemRaw: order,
    },
  });
}
