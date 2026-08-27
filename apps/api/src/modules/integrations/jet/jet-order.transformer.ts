import type { CanonicalOrder } from "@orderhub/shared";
import {
  jetItemSignature,
  jetMoney,
  jetOrderIdFrom,
  jetUnixToDate,
  mapJetFulfilment,
} from "./jet-order.mappers";

// Phase JE-1 — JET Connect order payload → CanonicalOrder.
//
// ⚠️ WRITTEN FROM THE SPEC, NOT FROM A REAL PAYLOAD. Every field below comes
// from the three worked examples in the JET OpenAPI document (delivery by
// partner, delivery by merchant, collection by customer). HubRise's documented
// shapes were wrong twice and Deliveroo's rider payload was wrong once, each
// costing about a day, so the receiver logs and persists the full raw envelope
// and this transformer must be re-checked against the first real order before
// any store goes live.
//
// Pure: no Nest, no Prisma, no I/O. The service layer decides what to DO with
// the result; this decides only what the result IS.

export interface JetTransformResult {
  canonical: CanonicalOrder;
  /**
   * Things that were surprising but not fatal. Surfaced in the intake log so
   * a shape drift shows up as a warning on order one rather than as a silent
   * mis-parse discovered a week later.
   */
  warnings: string[];
}

/** One entry of `payment.adjustments[]`, summed by name. */
function adjustmentTotal(payload: any, name: string): number {
  const rows = Array.isArray(payload?.payment?.adjustments)
    ? payload.payment.adjustments
    : [];
  let total = 0;
  for (const row of rows) {
    if (String(row?.name ?? "") === name) {
      total += jetMoney(row?.price?.inc_tax);
    }
  }
  return total;
}

/**
 * Turn one JET item (plus its `children` modifier options) into a canonical
 * line. `quantity` is supplied by the caller because JET expresses quantity by
 * repetition, not by a field.
 */
function toCanonicalItem(item: any, quantity: number) {
  const children = Array.isArray(item?.children) ? item.children : [];
  const unitPrice = jetMoney(item?.price);
  return {
    externalId: item?.plu ? String(item.plu) : undefined,
    sku: item?.plu ? String(item.plu) : undefined,
    name: String(item?.name ?? "Item"),
    quantity,
    unitPrice,
    totalPrice: unitPrice * quantity,
    modifiers: children.map((child: any) => ({
      name: String(child?.name ?? "Option"),
      price: jetMoney(child?.price),
      quantity: 1,
    })),
    notes: (item?.notes ?? "").trim() || undefined,
  };
}

/**
 * Collapse JET's repeated item entries into quantified lines.
 *
 * The spec's item schema has no quantity field, so two of the same burger
 * arrive as two objects. We still PROBE for a quantity field first: if a real
 * payload turns out to carry one, honouring it is correct and collapsing would
 * multiply the order. Order is preserved (first appearance wins) so the ticket
 * reads the way the customer built the basket.
 */
function collapseItems(
  rawItems: any[],
  warnings: string[],
): ReturnType<typeof toCanonicalItem>[] {
  const explicitQuantities = rawItems.some(
    (i) => Number.isFinite(Number(i?.quantity)) && Number(i?.quantity) > 0,
  );
  if (explicitQuantities) {
    warnings.push(
      "items carried an explicit `quantity` field (the spec has none) — " +
        "honouring it instead of collapsing repeats",
    );
    return rawItems.map((i) => toCanonicalItem(i, Number(i?.quantity) || 1));
  }

  const order: string[] = [];
  const bySignature = new Map<string, { item: any; count: number }>();
  for (const item of rawItems) {
    const sig = jetItemSignature(item);
    const hit = bySignature.get(sig);
    if (hit) {
      hit.count += 1;
    } else {
      bySignature.set(sig, { item, count: 1 });
      order.push(sig);
    }
  }
  return order.map((sig) => {
    const { item, count } = bySignature.get(sig)!;
    return toCanonicalItem(item, count);
  });
}

/**
 * Build the customer record.
 *
 * Which object holds the customer depends on fulfilment: `delivery` for both
 * delivery types, `collector` for collection. `driver` is never the customer —
 * it is the courier, and lands on the courier columns instead.
 *
 * Names and addresses can arrive masked ('****') for GDPR, and Just Eat via
 * HubRise is already known to send no customer name at all. So a blank or
 * fully-masked name falls back to a channel label rather than showing staff an
 * empty field or a row of asterisks.
 */
function toCustomer(payload: any, isPickup: boolean, warnings: string[]) {
  const source = isPickup ? payload?.collector : payload?.delivery;
  const first = String(source?.first_name ?? "").trim();
  const last = String(source?.last_name ?? "").trim();
  const joined = `${first} ${last}`.trim();
  // A masked value is all asterisks; treat it as absent rather than printing it.
  const masked = joined.length > 0 && /^\*+$/.test(joined.replace(/\s/g, ""));
  if (masked) warnings.push("customer name arrived masked by the delivery partner");
  const channelName = String(payload?.channel?.name ?? "").trim();
  const name =
    !joined || masked
      ? `${channelName || "Just Eat"} Customer`
      : joined;

  const phone = String(source?.phone_number ?? "").trim() || undefined;
  const email = String(source?.email ?? "").trim() || undefined;
  const accessCode = String(source?.phone_masking_code ?? "").trim() || undefined;

  return {
    name,
    phone,
    // The masked-email placeholder JET uses is not a real address; passing it
    // through would fail the CanonicalOrder email validation.
    ...(email && email.includes("@") && !email.endsWith(".hidden")
      ? { email }
      : {}),
    // The PIN the driver/shop quotes to the call centre to reach the customer.
    // Same field the HubRise and Deliveroo paths populate; the order drawer
    // and printed ticket already render it.
    ...(accessCode ? { phoneAccessCode: accessCode } : {}),
  } as CanonicalOrder["customerInfo"];
}

/** Delivery address, when the order has one. */
function toAddress(payload: any): CanonicalOrder["deliveryAddress"] {
  const d = payload?.delivery;
  if (!d) return undefined;
  const line1 =
    String(d.line_one ?? "").trim() ||
    [d.street_number, d.street].filter(Boolean).join(" ").trim();
  const city = String(d.city ?? "").trim();
  const postcode = String(d.postcode ?? "").trim();
  if (!line1 && !postcode) return undefined;

  const lat = Number(d?.coordinates?.latitude);
  const lng = Number(d?.coordinates?.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

  return {
    line1,
    line2: String(d.line_two ?? "").trim() || undefined,
    city,
    postcode,
    country: "GB",
    ...(hasCoords ? { coordinates: { lat, lng } } : {}),
  };
}

/**
 * Transform a Receive Order / Final Picked Order payload into a CanonicalOrder.
 *
 * Returns null only when the payload carries no order id, which is the one
 * thing we cannot work around: without it there is nothing to be idempotent
 * on and nothing to acknowledge.
 */
export function transformJetOrder(payload: any): JetTransformResult | null {
  const externalId = jetOrderIdFrom(payload);
  if (!externalId) return null;

  const warnings: string[] = [];
  const { fulfillmentType, deliveryType } = mapJetFulfilment(payload?.type);
  const isPickup = fulfillmentType === "PICKUP";

  if (!payload?.type) warnings.push("order carried no `type` — assumed partner delivery");

  // ── Items ────────────────────────────────────────────────────────────
  //
  // Promotional items are DELIBERATELY folded in. The spec states that when an
  // item-level promotion applies, the affected items "won't appear on the top
  // level items array, but on the `promotion.items` one" — so reading only the
  // top-level array means a free side never reaches the kitchen and the
  // customer is handed a short bag. They are tagged so the ticket can mark
  // them and so their price is traceable against the discount adjustment.
  const rawItems = Array.isArray(payload?.items) ? [...payload.items] : [];
  const promotions = Array.isArray(payload?.promotions) ? payload.promotions : [];
  const promoItems: any[] = [];
  for (const promo of promotions) {
    const items = Array.isArray(promo?.items) ? promo.items : [];
    for (const item of items) {
      promoItems.push({
        ...item,
        notes: [item?.notes, `Promotion: ${promo?.type ?? "offer"}`]
          .map((s: unknown) => String(s ?? "").trim())
          .filter(Boolean)
          .join(" — "),
      });
    }
  }
  if (promoItems.length) {
    warnings.push(
      `${promoItems.length} promotional item(s) merged in from promotions[] ` +
        `(JET omits them from the top-level items array)`,
    );
  }
  const items = collapseItems([...rawItems, ...promoItems], warnings);
  if (items.length === 0) warnings.push("order contained no items");

  // ── Money ────────────────────────────────────────────────────────────
  //
  // Every total comes from JET rather than being recomputed from the lines.
  // Their `final.inc_tax` is what the customer was charged and what the
  // restaurant is settled on; a locally-summed total that disagreed with it
  // would be wrong in the only way that matters.
  const subtotal = jetMoney(payload?.payment?.items_in_cart?.inc_tax);
  const total = jetMoney(payload?.payment?.final?.inc_tax);
  const taxAmount = jetMoney(payload?.payment?.final?.tax);
  const deliveryFee = adjustmentTotal(payload, "deliveryFee");
  const serviceCharge = adjustmentTotal(payload, "serviceCharge");
  // Adjustment amounts are always positive; the `discount` one is subtracted
  // from the total by JET, so we store its magnitude.
  const discount = adjustmentTotal(payload, "discount");
  // Present on the payload, deliberately NOT written to the order: there is no
  // tipAmount column on Order, and writing to a column that does not exist
  // takes checkout down rather than merely losing the value. It rides in
  // metadata until a migration adds a home for it.
  const driverTip = adjustmentTotal(payload, "driverTip");

  // ── Timing ───────────────────────────────────────────────────────────
  // collect_at is set on partner-delivery and collection orders; deliver_at on
  // merchant-delivery ones. Either way it is when the food must be ready.
  const dueAt =
    jetUnixToDate(payload?.collect_at) ?? jetUnixToDate(payload?.deliver_at);

  // collect_at is ALSO the board's pickup ETA — but only when a partner's
  // driver is doing the collecting. On a collection-by-customer order the same
  // field is when the CUSTOMER is coming, and putting that in a courier column
  // would invent a rider who does not exist.
  //
  // Per the JET Connect spec: collect_at is present on
  // delivery-by-delivery-partner and collection-by-customer; deliver_at on
  // delivery-by-merchant.
  const courierPickupEtaAt =
    fulfillmentType === "PLATFORM_COURIER"
      ? jetUnixToDate(payload?.collect_at)
      : undefined;
  const createdAt = jetUnixToDate(payload?.created_at);

  // ── Notes ────────────────────────────────────────────────────────────
  // Three separate note fields, each of which the kitchen or driver needs.
  // Joined the way the Deliveroo adapter joins its three, so one glance at the
  // ticket shows everything the customer asked for.
  const specialInstructions =
    [payload?.kitchen_notes, payload?.delivery_notes, payload?.collection_notes]
      .map((s: unknown) => String(s ?? "").trim())
      .filter(Boolean)
      .join(" — ") || undefined;

  const paymentMethod = String(payload?.payment_method ?? "").trim().toUpperCase();
  // CARD orders are prepaid by the platform. CASH and the HOME_* methods are
  // collected at the door, so they are still outstanding when the order lands.
  const paymentStatus = paymentMethod === "CARD" ? "PAID" : "PENDING";

  const driver = payload?.driver;
  const driverName = driver
    ? `${String(driver.first_name ?? "").trim()} ${String(driver.last_name ?? "").trim()}`.trim()
    : "";

  const canonical: CanonicalOrder = {
    externalId,
    platform: "JUST_EAT",
    // The reference the CUSTOMER sees and quotes at the door. Falling back to
    // JET's internal id would show staff a UUID nobody can match to anything.
    displayId: String(payload?.third_party_order_reference ?? externalId),
    orderSource: "JUST_EAT",
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType,
    ...(courierPickupEtaAt ? { courierPickupEtaAt } : {}),
    customerInfo: toCustomer(payload, isPickup, warnings),
    deliveryAddress: isPickup ? undefined : toAddress(payload),
    items,
    subtotal,
    taxAmount,
    deliveryFee,
    discount,
    total,
    ...(specialInstructions ? { specialInstructions } : {}),
    ...(dueAt ? { scheduledFor: dueAt } : {}),
    metadata: {
      deliveryType,
      paymentMethod: paymentMethod === "CASH" ? "CASH" : "CARD",
      paymentStatus,
      serviceCharge,
      jet: {
        orderId: externalId,
        thirdPartyOrderReference: payload?.third_party_order_reference ?? null,
        type: payload?.type ?? null,
        posLocationId: payload?.posLocationId ?? null,
        jetLocationId: payload?.location?.id ?? null,
        timezone: payload?.location?.timezone ?? null,
        channel: payload?.channel?.name ?? null,
        channelId: payload?.channel?.id ?? null,
        tenderType: payload?.tender_type ?? null,
        paymentMethod: paymentMethod || null,
        deposit: jetMoney(payload?.payment?.deposit),
        driverTip,
        createdAt: createdAt ? createdAt.toISOString() : null,
        justEatOrderApiId: payload?.extras?.just_eat_order_api_id ?? null,
        promotions: promotions.map((p: any) => ({
          type: p?.type ?? null,
          promotionId: p?.promotion_id ?? null,
          offerId: p?.offer_id ?? null,
          discountValue: jetMoney(p?.discount_value),
        })),
        // Substitution preferences are grocery-only today, but recording them
        // is what lets the JE-6 modification flow know an item was marked
        // substitutable without re-reading the raw payload.
        substitutable: (Array.isArray(payload?.items) ? payload.items : [])
          .filter((i: any) => i?.substitution?.preference)
          .map((i: any) => ({
            plu: i?.plu ?? null,
            preference: i.substitution.preference,
          })),
      },
      ...(driverName || driver?.phone_number
        ? {
            courier: {
              name: driverName || null,
              phone: String(driver?.phone_number ?? "").trim() || null,
              phoneAccessCode:
                String(driver?.phone_masking_code ?? "").trim() || null,
            },
          }
        : {}),
    },
  } as CanonicalOrder;

  return { canonical, warnings };
}
