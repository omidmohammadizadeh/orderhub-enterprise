import type { CanonicalOrder } from "@orderhub/shared";
import {
  glovoLocalToDate,
  glovoMoney,
  glovoOrderIdFrom,
  glovoStoreIdFrom,
  mapGlovoFulfilment,
  round2,
} from "./glovo-order.mappers";

// Phase GL-2 — Glovo `order dispatched` payload → CanonicalOrder.
//
// ⚠️ WRITTEN FROM THE SPEC, NOT FROM A REAL PAYLOAD (Order model in the
// restaurant Partners API definition.yaml). HubRise's and Deliveroo's
// documented shapes were both wrong in places; the receiver persists the full
// raw envelope of every delivery, and this file must be diffed against the
// first real order before any store goes live.
//
// Pure: no Nest, no Prisma, no I/O.
//
// Things the spec says that are easy to get wrong:
//   - ORDER money is integer CENTS; menu prices are decimals. See glovoMoney.
//   - `price` on a product is the unit price WITHOUT attributes, and its
//     `discount` covers ALL units of the line, not one.
//   - Attribute `price` is a unit price. Whether attribute `quantity` is per
//     product unit or for the whole line is NOT stated — we read it as per
//     unit (two burgers each with extra cheese = two extra cheeses), which is
//     what every other marketplace does. On the question list for Glovo.
//   - Times are local with no offset; `utc_offset_minutes` is a string.
//   - For Glovo-courier orders, customer phone is the literal "N/A" and the
//     delivery address is null. Only marketplace orders carry either.
//   - `payment_method` is how GLOVO PAYS THE STORE, not how the customer paid:
//     CASH means the courier hands the store cash at pickup.

export interface GlovoTransformResult {
  canonical: CanonicalOrder;
  /** Surprising-but-not-fatal things, logged at intake so shape drift shows on order one. */
  warnings: string[];
}

type Line = CanonicalOrder["items"][number];
type Modifier = Line["modifiers"][number];

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function attributesOf(raw: any, depth = 0): Modifier[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((a: any) => ({
    name: String(a?.name ?? "Option"),
    price: glovoMoney(a?.price),
    quantity: Math.max(1, num(a?.quantity, 1)),
    ...(depth > 0 ? { depth } : {}),
  }));
}

/**
 * One Glovo product → one canonical line.
 *
 * A combo's `sub_products` are the parts the customer chose ("Cheese Burger",
 * "Fries", "Coke"), each with its own attributes. The kitchen needs to see
 * them, so they become modifiers at depth 0 with their own attributes one
 * level beneath — the ticket indents by depth, so it reads as the tree it is.
 */
function toLine(product: any): Line {
  const quantity = Math.max(1, Math.round(num(product?.quantity, 1)));
  const unitPrice = glovoMoney(product?.price);

  const modifiers: Modifier[] = [...attributesOf(product?.attributes)];
  for (const sub of Array.isArray(product?.sub_products) ? product.sub_products : []) {
    const subQty = Math.max(1, num(sub?.quantity, 1));
    modifiers.push({
      name: String(sub?.name ?? "Item"),
      // A combo part is included in the combo price; `price` here is only its
      // SURCHARGE ("If there is no surcharge, this field will be set to 0").
      price: glovoMoney(sub?.price),
      quantity: subQty,
    });
    modifiers.push(...attributesOf(sub?.attributes, 1));
  }

  // Per unit: base + every modifier (qty × unit price). Then × quantity.
  const perUnit =
    unitPrice + modifiers.reduce((s, m) => s + m.price * (m.quantity ?? 1), 0);
  const totalPrice = round2(perUnit * quantity);

  const id = product?.id != null ? String(product.id) : undefined;
  return {
    ...(id ? { externalId: id, sku: id } : {}),
    name: String(product?.name ?? "Item"),
    quantity,
    unitPrice,
    totalPrice,
    modifiers,
  };
}

/** A usable customer name, or a channel label — never blank, never "N/A". */
function customerName(payload: any, warnings: string[]): string {
  const raw = String(payload?.customer?.name ?? "").trim();
  if (!raw || raw.toUpperCase() === "N/A" || /^\*+$/.test(raw)) {
    if (!raw) warnings.push("customer name missing");
    return "Glovo Customer";
  }
  return raw;
}

/** "N/A" and blanks are not phone numbers. */
function customerPhone(payload: any): string | undefined {
  const raw = String(payload?.customer?.phone_number ?? "").trim();
  if (!raw || raw.toUpperCase() === "N/A" || !/\d/.test(raw)) return undefined;
  return raw;
}

function toAddress(payload: any, country: string): CanonicalOrder["deliveryAddress"] {
  const a = payload?.delivery_address;
  if (!a || typeof a !== "object") return undefined;
  const street = [a.street_name, a.street_number]
    .map((s: unknown) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const label = String(a.label ?? "").trim();
  const line1 = street || label;
  if (!line1) return undefined;
  const line2 =
    [
      a.building_name,
      a.floor_number ? `Floor ${a.floor_number}` : "",
      a.door_number ? `Door ${a.door_number}` : "",
    ]
      .map((s: unknown) => String(s ?? "").trim())
      .filter(Boolean)
      .join(", ") || undefined;
  const lat = Number(a.latitude);
  const lng = Number(a.longitude);
  const hasCoords =
    Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    // The spec has no `city` field on the address — the label is "complete
    // delivery address including city" and province is the nearest field.
    city: String(a.province ?? "").trim(),
    ...(a.postal_code ? { postcode: String(a.postal_code).trim() } : {}),
    country,
    ...(hasCoords ? { coordinates: { lat, lng } } : {}),
  };
}

/**
 * Transform a Glovo order into a CanonicalOrder.
 *
 * `country` is the shop's own ISO country (the connection's location) —
 * Glovo's order carries a currency but no country, and CanonicalOrder's
 * address would otherwise default to GB.
 *
 * Returns null only when there is no order id — without it there is nothing
 * to be idempotent on.
 */
export function transformGlovoOrder(
  payload: any,
  ctx: { country?: string | null } = {},
): GlovoTransformResult | null {
  const externalId = glovoOrderIdFrom(payload);
  if (!externalId) return null;

  const warnings: string[] = [];
  const country = String(ctx.country ?? "").trim().toUpperCase() || "ES";
  const { fulfillmentType, deliveryType, marketplace } = mapGlovoFulfilment(payload);

  // ── Items ──────────────────────────────────────────────────────────────
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const items = products.map(toLine);
  if (items.length === 0) warnings.push("order contained no products");

  // ── Money ──────────────────────────────────────────────────────────────
  // Glovo's own numbers, not a re-sum of our lines: it is what the store is
  // settled on. estimated_total_price is products + attributes (tax included,
  // delivery excluded) BEFORE promotions.
  const linesTotal = round2(items.reduce((s: number, i: Line) => s + i.totalPrice, 0));
  const subtotal =
    payload?.estimated_total_price != null
      ? glovoMoney(payload.estimated_total_price)
      : linesTotal;
  if (payload?.estimated_total_price != null && Math.abs(subtotal - linesTotal) > 0.011) {
    warnings.push(
      `line totals (${linesTotal}) differ from estimated_total_price (${subtotal}) — ` +
        `check attribute quantity semantics against this envelope`,
    );
  }

  const partnerDiscount = glovoMoney(payload?.partner_discounts_products);
  const glovoDiscount = glovoMoney(payload?.glovo_discounts_products);
  // discounted_products_total is "after ALL promotional discounts", so the
  // difference is the whole discount whoever funded it. Fall back to the two
  // funded components when it is absent.
  const discount =
    payload?.discounted_products_total != null
      ? round2(Math.max(0, subtotal - glovoMoney(payload.discounted_products_total)))
      : round2(partnerDiscount + glovoDiscount);

  const deliveryFee = glovoMoney(payload?.delivery_fee);
  const serviceFee = glovoMoney(payload?.service_fee);
  const basketSurcharge = glovoMoney(payload?.minimum_basket_surcharge);

  // Marketplace orders carry what the customer actually pays; the store
  // collects it, so the fees in it belong on the ticket. On a Glovo-courier
  // order the service fee is Glovo's business with the customer, not the
  // store's — the store's number is the discounted goods total.
  let total: number;
  let serviceCharge = 0;
  if (marketplace && payload?.total_customer_to_pay != null) {
    total = glovoMoney(payload.total_customer_to_pay);
    serviceCharge = round2(serviceFee + basketSurcharge);
  } else {
    total = round2(Math.max(0, subtotal - discount));
  }

  // ── Timing ─────────────────────────────────────────────────────────────
  const offset = payload?.utc_offset_minutes;
  const orderTime = glovoLocalToDate(payload?.order_time, offset);
  const pickupEta = glovoLocalToDate(payload?.estimated_pickup_time, offset);
  if (payload?.order_time && !orderTime) {
    warnings.push(`order_time "${payload.order_time}" did not parse`);
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  // The pick-up code leads: the spec requires it "displayed in a visible
  // location" — it is how a courier (or the customer) claims the right bag,
  // and it is NOT the order_code shown as the order number.
  const pickUpCode = String(payload?.pick_up_code ?? "").trim();
  const allergy = String(payload?.allergy_info ?? "").trim();
  const special = String(payload?.special_requirements ?? "").trim();
  const notes = [
    pickUpCode ? `Glovo pick-up code ${pickUpCode}` : "",
    allergy ? `ALLERGY: ${allergy}` : "",
    special,
    payload?.cutlery_requested === true ? "Cutlery requested" : "",
    payload?.payment_method === "CASH"
      ? "Glovo courier pays the store in cash at pickup"
      : "",
  ].filter(Boolean);

  const paymentMethod = String(payload?.payment_method ?? "").trim().toUpperCase();
  const courierName = String(payload?.courier?.name ?? "").trim();
  const courierPhone = String(payload?.courier?.phone_number ?? "").trim();

  const canonical: CanonicalOrder = {
    externalId,
    platform: "GLOVO" as any,
    // What support, invoices and the Partner Webapp call the order.
    displayId: String(payload?.order_code ?? "").trim() || externalId,
    orderSource: "GLOVO" as any,
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType,
    ...(fulfillmentType === "PLATFORM_COURIER" && pickupEta
      ? { courierPickupEtaAt: pickupEta }
      : {}),
    customerInfo: {
      name: customerName(payload, warnings),
      ...(customerPhone(payload) ? { phone: customerPhone(payload) } : {}),
    },
    deliveryAddress:
      fulfillmentType === "MERCHANT_DELIVERY" ? toAddress(payload, country) : undefined,
    items,
    subtotal,
    taxAmount: 0,
    deliveryFee,
    discount,
    ...(serviceCharge > 0 ? { serviceCharge } : {}),
    total,
    ...(notes.length ? { specialInstructions: notes.join(" — ") } : {}),
    metadata: {
      deliveryType,
      // CASH is still owed (by the courier, at pickup); DELAYED is settled by
      // Glovo's invoice, i.e. already the store's money.
      paymentMethod: paymentMethod === "CASH" ? "CASH" : "CARD",
      paymentStatus: paymentMethod === "CASH" ? "PENDING" : "PAID",
      ...(courierName || courierPhone
        ? { courier: { name: courierName || null, phone: courierPhone || null } }
        : {}),
      glovo: {
        orderId: externalId,
        storeId: glovoStoreIdFrom(payload),
        orderCode: payload?.order_code ?? null,
        pickUpCode: pickUpCode || null,
        currency: payload?.currency ?? null,
        paymentMethod: paymentMethod || null,
        marketplace,
        orderTime: orderTime ? orderTime.toISOString() : null,
        estimatedPickupTime: pickupEta ? pickupEta.toISOString() : null,
        utcOffsetMinutes: offset ?? null,
        customerHash: payload?.customer?.hash ?? null,
        invoicingDetails: payload?.customer?.invoicing_details ?? null,
        customerCashPaymentAmount:
          payload?.customer_cash_payment_amount != null
            ? glovoMoney(payload.customer_cash_payment_amount)
            : null,
        bundledOrders: Array.isArray(payload?.bundled_orders) ? payload.bundled_orders : [],
        partnerDiscount,
        glovoDiscount,
        serviceFee,
        minimumBasketSurcharge: basketSurcharge,
        loyaltyCard: payload?.loyalty_card ?? null,
        voucherCode: payload?.voucher_code ?? null,
        allergyInfo: allergy || null,
        cutleryRequested: payload?.cutlery_requested ?? null,
        // Needed for any later order modification (replace_products).
        purchasedProductIds: products.map((p: any) => ({
          productId: p?.id ?? null,
          purchasedProductId: p?.purchased_product_id ?? null,
        })),
      },
    },
  } as CanonicalOrder;

  return { canonical, warnings };
}
