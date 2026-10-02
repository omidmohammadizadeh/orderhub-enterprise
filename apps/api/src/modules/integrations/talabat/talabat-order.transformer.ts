import { CanonicalOrderSchema, type CanonicalOrder, type OrderItem } from "@orderhub/shared";
import { num, summarizeTalabatDiscounts } from "./talabat-promotions";
import type { TalabatOrder, TalabatTopping } from "./talabat-types";

// Phase TB-2 — a Delivery Hero dispatch payload → CanonicalOrder.
//
// Read off pluginOrder.yaml and its two worked examples. Both examples are
// illustrative rather than arithmetically consistent (the generic one has a
// pickup order carrying a rider pickup time and a quantity of "string"), so
// nothing here derives one of their totals from another. Their numbers are
// taken as given and our cross-check is recorded, not enforced.
//
// ── The three order types (their own decision procedure) ────────────────────
//
//   expeditionType "pickup"                        → customer collects
//   expeditionType "delivery", riderPickupTime set → a Talabat rider collects
//                                                   ("Own Delivery")
//   expeditionType "delivery", riderPickupTime null → the RESTAURANT delivers
//                                                   ("Vendor Delivery")
//
// The address is null for Own Delivery and present for Vendor Delivery —
// Talabat keep their customer's address when their rider is driving.
//
// ── Test orders ─────────────────────────────────────────────────────────────
//
// `test: true` only ever arrives on a direct integration, and the spec says
// plugins "should make sure that the order won't be prepared in the kitchen".
// It still lands on the board (staging certification is made of them), loudly
// labelled, and flagged so the sync can reject it with TEST_ORDER if staff
// decline it.

export type TalabatOrderKind = "PICKUP" | "OWN_DELIVERY" | "VENDOR_DELIVERY";

/** Their decision procedure, verbatim, as a function. */
export function talabatOrderKind(order: Pick<TalabatOrder, "expeditionType" | "delivery">): TalabatOrderKind {
  const exp = String(order.expeditionType ?? "").toLowerCase();
  if (exp.includes("pickup")) return "PICKUP";
  // Absent delivery block on a delivery order: no rider time is known, which
  // by their rule is vendor delivery.
  return order.delivery?.riderPickupTime ? "OWN_DELIVERY" : "VENDOR_DELIVERY";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Quantities arrive as strings ("4"), numbers, or junk ("string" in their example). */
function qty(raw: unknown): number {
  const n = Math.round(num(raw));
  return n >= 1 ? n : 1;
}

/**
 * Flatten the selected-topping tree into our modifier list.
 *
 * Toppings nest up to five levels ("A topping can be nested up to 5 levels").
 * Our modifiers are flat with a depth, and the ticket indents by it — the
 * same shape nested modifiers already use everywhere else.
 */
export function flattenTalabatToppings(
  toppings: TalabatTopping[] | undefined,
  depth = 0,
): Array<{ name: string; price: number; quantity: number; depth: number }> {
  const out: Array<{ name: string; price: number; quantity: number; depth: number }> = [];
  for (const t of toppings ?? []) {
    out.push({
      name: String(t.name ?? "").trim() || String(t.remoteCode ?? t.id ?? "?"),
      price: round2(num(t.price)),
      quantity: qty(t.quantity),
      depth,
    });
    if (t.children?.length) out.push(...flattenTalabatToppings(t.children, depth + 1));
  }
  return out;
}

function addressLine1(a: NonNullable<NonNullable<TalabatOrder["delivery"]>["address"]>): string {
  const street = [a.number, a.street].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
  const unit = [
    a.flatNumber ? `Flat ${a.flatNumber}` : "",
    a.floor ? `Floor ${a.floor}` : "",
    a.building ?? "",
  ]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(", ");
  return [unit, street].filter(Boolean).join(", ");
}

function isoOrNull(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface TalabatTransformContext {
  /** The location's country — the fallback when the order omits one. */
  country?: string | null;
  /** The vendor's remoteId (our posVendorId) the order was dispatched to. */
  remoteId: string;
}

export function transformTalabatOrder(order: TalabatOrder, ctx: TalabatTransformContext): {
  canonical: CanonicalOrder;
  warnings: string[];
} {
  const warnings: string[] = [];
  const kind = talabatOrderKind(order);
  const price = order.price ?? {};

  const items: OrderItem[] = (order.products ?? []).map((p) => {
    const quantity = qty(p.quantity);
    const total = round2(num(p.paidPrice));
    const modifiers = flattenTalabatToppings(p.selectedToppings);
    return {
      // The platform's product id — what a product modification must quote.
      ...(p.id ? { externalId: String(p.id) } : {}),
      name: String(p.name ?? "").trim() || String(p.remoteCode ?? "Unknown item"),
      quantity,
      // paidPrice is "the total price of the product" as charged. The unit is
      // derived from it rather than taken from unitPrice ("base price, without
      // toppings") so a line's own arithmetic holds on the ticket.
      unitPrice: round2(total / quantity),
      totalPrice: total,
      modifiers,
      ...(p.comment ? { notes: String(p.comment) } : {}),
      // The id WE published — how a line gets back to our MenuItem.
      ...(p.remoteCode ? { sku: String(p.remoteCode) } : {}),
    };
  });
  if (items.length === 0) warnings.push("Order has no products");
  const unmapped = (order.products ?? []).filter((p) => !p.remoteCode).length;
  if (unmapped) {
    warnings.push(
      `${unmapped} line(s) carry no remoteCode — the product was not published from OrderHub, ` +
        "so it cannot be matched to our menu (publish the catalog to fix)",
    );
  }

  const promotions = summarizeTalabatDiscounts(order);
  const discount = promotions.total || round2(Math.abs(num(price.discountAmountTotal)));
  // `deliveryFee` is "the total amount of all applied fees"; fall back to the
  // itemised list when it is absent (their generic example only has the list).
  const feeList = (price.deliveryFees ?? []).reduce((a, f) => a + num(f?.value), 0);
  const deliveryFee = round2(price.deliveryFee != null && price.deliveryFee !== "" ? num(price.deliveryFee) : feeList);
  const total = round2(num(price.grandTotal));
  const taxAmount = round2(Math.max(0, num(price.vatTotal)));
  const riderTip = round2(Math.max(0, num(price.riderTip)));
  const lineSum = round2(items.reduce((a, i) => a + i.totalPrice, 0));

  // Recorded, never enforced: their examples don't satisfy their own formula,
  // so a mismatch here is information for the first real order, not an error.
  const expectedTotal = round2(lineSum - discount + deliveryFee);
  const priceCheck = {
    lineSum,
    discount,
    deliveryFee,
    grandTotal: total,
    expectedFromLines: expectedTotal,
    matches: Math.abs(expectedTotal - total) < 0.02,
  };

  const addr = order.delivery?.address ?? null;
  const country = String(order.localInfo?.countryCode ?? ctx.country ?? "AE").toUpperCase();
  const name = [order.customer?.firstName, order.customer?.lastName]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const phone = String(order.customer?.mobilePhone ?? "").trim();

  // When the kitchen should be working towards — the time the spec tells
  // plugins to use per order type.
  const dueAt =
    kind === "OWN_DELIVERY"
      ? isoOrNull(order.delivery?.riderPickupTime)
      : kind === "PICKUP"
        ? isoOrNull(order.pickup?.pickupTime)
        : isoOrNull(order.delivery?.expectedDeliveryTime);

  const paid = String(order.payment?.status ?? "").toLowerCase() === "paid";
  // Cash the restaurant (or its driver) must collect. collectFromCustomer is
  // the amount "to get from the customer"; only meaningful when unpaid.
  const collect = paid ? 0 : round2(num(price.collectFromCustomer) || total);

  const shortCode = String(order.shortCode ?? "").trim();
  const test = order.test === true;

  const instructions = [
    test ? "⚠️ TALABAT TEST ORDER — DO NOT PREPARE" : "",
    order.comments?.customerComment,
    addr?.deliveryInstructions ? `Delivery: ${addr.deliveryInstructions}` : "",
    order.pickup?.pickupCode ? `Pickup code ${order.pickup.pickupCode}` : "",
    !paid && collect > 0 ? `Collect ${collect.toFixed(2)} from the customer` : "",
  ]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" · ");

  const canonical = CanonicalOrderSchema.parse({
    // The middleware token, not the platform code: every callback, status
    // update and report lookup is keyed on it, and it is what dedupes a
    // re-dispatch after a timeout.
    externalId: String(order.token),
    platform: "TALABAT",
    orderSource: "TALABAT",
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType:
      kind === "PICKUP" ? "PICKUP" : kind === "OWN_DELIVERY" ? "PLATFORM_COURIER" : "DELIVERY",
    // The rider asks for the short code at the counter, so it is what the
    // ticket leads with; the platform code is the fallback.
    displayId: `TB-${shortCode || String(order.code ?? order.token).slice(-8)}`,
    customerInfo: {
      name: name || "Talabat customer",
      ...(phone && /\d{5,}/.test(phone) ? { phone } : {}),
    },
    ...(kind === "VENDOR_DELIVERY" && addr
      ? {
          deliveryAddress: {
            line1: addressLine1(addr) || String(addr.deliveryArea ?? addr.deliveryMainArea ?? ""),
            ...(addr.entrance || addr.intercom
              ? { line2: [addr.entrance && `Entrance ${addr.entrance}`, addr.intercom && `Intercom ${addr.intercom}`].filter(Boolean).join(", ") }
              : {}),
            city: String(addr.city ?? ""),
            ...(addr.postcode ? { postcode: String(addr.postcode) } : {}),
            ...(addr.deliveryArea || addr.deliveryMainArea
              ? { area: String(addr.deliveryArea || addr.deliveryMainArea) }
              : {}),
            country,
            ...(Number.isFinite(addr.latitude) && Number.isFinite(addr.longitude) && (addr.latitude || addr.longitude)
              ? { coordinates: { lat: Number(addr.latitude), lng: Number(addr.longitude) } }
              : {}),
          },
        }
      : {}),
    items,
    subtotal: lineSum,
    taxAmount,
    deliveryFee,
    discount,
    total,
    ...(instructions ? { specialInstructions: instructions } : {}),
    ...(order.preOrder && dueAt ? { scheduledFor: new Date(dueAt) } : {}),
    metadata: {
      // OUR vocabulary for who drives (see Careem's note on deliveryType):
      // PLATFORM hands the post-READY flow to Talabat's rider, MERCHANT walks
      // staff through to delivered.
      ...(kind !== "PICKUP" ? { deliveryType: kind === "OWN_DELIVERY" ? "PLATFORM" : "MERCHANT" } : {}),
      paymentMethod: paid ? "CARD" : String(order.payment?.type ?? "").toLowerCase().includes("cash") ? "CASH" : "CARD",
      paymentStatus: paid ? "PAID" : "PENDING",
      talabat: {
        token: String(order.token),
        code: order.code ?? null,
        shortCode: shortCode || null,
        remoteId: ctx.remoteId,
        platformVendorId: order.platformRestaurant?.id ?? null,
        platformKey: order.localInfo?.platformKey ?? null,
        kind,
        test,
        preOrder: order.preOrder === true,
        createdAt: isoOrNull(order.createdAt),
        expiresAt: isoOrNull(order.expiryDate),
        riderPickupTime: isoOrNull(order.delivery?.riderPickupTime),
        expectedDeliveryTime: isoOrNull(order.delivery?.expectedDeliveryTime),
        pickupTime: isoOrNull(order.pickup?.pickupTime),
        pickupCode: order.pickup?.pickupCode ?? null,
        dueAt,
        expressDelivery: order.delivery?.expressDelivery === true,
        paymentType: order.payment?.type ?? null,
        paid,
        collectFromCustomer: collect,
        payRestaurant: round2(num(price.payRestaurant)),
        riderTip,
        callbackUrls: order.callbackUrls ?? {},
        prepTime: order.preparationTimeAdjustmentInformation ?? null,
        // Per-line handling preference for out-of-stock items — what the
        // product-modification flow is allowed to do with each line.
        lines: (order.products ?? []).map((p) => ({
          id: p.id ?? null,
          remoteCode: p.remoteCode ?? null,
          name: p.name ?? null,
          quantity: qty(p.quantity),
          handling: p.itemUnavailabilityHandling ?? null,
          toppings: (p.selectedToppings ?? []).map((t) => ({
            id: t.id ?? null,
            remoteCode: t.remoteCode ?? null,
            name: t.name,
            type: t.type ?? null,
          })),
        })),
        promotions,
        priceCheck,
        corporateTaxId: order.corporateTaxId || null,
      },
      // Kept so the first real order can be diffed against the spec this was
      // written from.
      talabatRaw: order,
    },
  });

  if (!priceCheck.matches && items.length) {
    warnings.push(
      `Lines ${lineSum} − discount ${discount} + fees ${deliveryFee} = ${expectedTotal}, ` +
        `but Talabat's grandTotal is ${total}. Using Talabat's figure.`,
    );
  }
  return { canonical, warnings };
}
