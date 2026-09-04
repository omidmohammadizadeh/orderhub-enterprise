// Phase AU — HubRise webhook adapter.
//
// HubRise hands us the order body directly at the top level (no
// `resource_type` / `resource` wrapper), and money fields come back as
// strings with the currency suffix ("38.70 GBP"). Channel is a plain
// string ("Uber Eats"), not an object. The adapter normalises all of
// that to our canonical Order shape.

import * as crypto from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

@Injectable()
export class HubRiseAdapter extends BaseWebhookAdapter {
  readonly platform = "HUBRISE";
  private readonly logger = new Logger(HubRiseAdapter.name);

  // HubRise's `channel` is a free-form display string set by the
  // operator on each connection. Match loosely so "Uber Eats", "uber
  // eats", "UberEats" all collapse to UBER_EATS.
  private static readonly CHANNEL_PATTERNS: Array<[RegExp, string]> = [
    [/uber\s*eats/i, "UBER_EATS"],
    [/deliveroo/i, "DELIVEROO"],
    [/just\s*eat/i, "JUST_EAT"],
    [/talabat/i, "TALABAT"],
    [/doordash/i, "DOORDASH"],
    [/grubhub/i, "GRUBHUB"],
    [/careem/i, "CAREEM"],
  ];

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ) {
    const sig = headers["x-hubrise-signature"] as string | undefined;
    if (!sig) return { valid: false, reason: "Missing x-hubrise-signature header" };
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    const valid = crypto.timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expected),
    );
    return { valid };
  }

  extractEventId(
    rawPayload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): string {
    const p = rawPayload as Record<string, any>;
    // Order id is top-level; fall back to the HubRise request id
    // header so non-order events (catalog.updated, etc.) still get a
    // stable idempotency key.
    return (
      p?.id ??
      (headers["x-hubrise-request-id"] as string) ??
      ""
    );
  }

  normalize(rawPayload: unknown, _locationId: string): CanonicalOrder | null {
    const order = rawPayload as Record<string, any>;
    // We only care about order events — anything without an `id` and
    // an `items` array is something else (catalog change, customer
    // update) and should be skipped without erroring.
    if (!order?.id || !Array.isArray(order?.items)) return null;

    const externalId: string = order.id;
    const originPlatform = this.mapChannel(order.channel) ?? "HUBRISE";

    const items = order.items.map((item: any) => {
      const qty = parseNum(item.quantity, 1);
      const unitPrice = parseMoney(item.price);
      return {
        name: item.product_name ?? item.sku_name ?? "Item",
        quantity: qty,
        unitPrice,
        totalPrice: parseMoney(item.subtotal) || unitPrice * qty,
        modifiers: (item.options ?? []).map((o: any) => ({
          name: o.name,
          price: parseMoney(o.price),
          quantity: parseNum(o.quantity, 1),
        })),
        notes: item.customer_notes ?? null,
        // Carry the HubRise ref through so we can mark-86 the exact
        // SKU later without re-resolving from product name.
        sku: item.sku_ref ?? undefined,
        externalId: item.id ?? undefined,
      };
    });

    const customer = order.customer ?? {};
    const delivery = order.delivery ?? {};
    // Customer name field varies a lot by marketplace. Just Eat (via HubRise)
    // often leaves first_name/last_name blank and puts the display name in a
    // single `name` field or on the order's customer_list entry — which is
    // why those orders showed the "HubRise Customer" placeholder. Try every
    // known source in order of specificity before giving up.
    const clean = (v: unknown): string =>
      typeof v === "string" ? v.trim() : "";
    const joined = [customer.first_name, customer.last_name]
      .map(clean)
      .filter(Boolean)
      .join(" ")
      .trim();
    const channel = clean((order as any).channel);
    const realName =
      joined ||
      clean(customer.name) ||
      clean(customer.full_name) ||
      clean((order as any).customer_name) ||
      clean((order as any).customer_list_name) ||
      clean(delivery.contact_name) ||
      clean(delivery.name) ||
      clean(customer.company_name);
    // Verified against the raw payload: Just Eat via HubRise sends NO customer
    // name (first_name/last_name/company_name all null, custom_fields empty,
    // anonymised=false) — only a phone. When no real name is present, fall back
    // to the actual CHANNEL ("Just Eat Customer") instead of the middleware
    // ("HubRise Customer") — accurate and clearer on the board. Uber Eats /
    // Deliveroo DO send names, so they're unaffected.
    const customerName =
      realName || (channel ? `${channel} Customer` : "HubRise Customer");
    // If no real name resolved, log the keys so any marketplace that DOES send
    // a name in a field we haven't seen yet is visible in the Render log.
    if (!realName) {
      this.logger.warn(
        `HubRise order ${order.id ?? "?"} has no resolvable customer name — customer keys: [${Object.keys(
          customer,
        ).join(", ")}], delivery keys: [${Object.keys(delivery).join(
          ", ",
        )}], order keys: [${Object.keys(order).join(", ")}]`,
      );
    }

    // HubRise service_type values: "delivery" | "collection" | "eat_in".
    // Map onto our fulfillment enum. MERCHANT_DELIVERY means the shop
    // delivers themselves; HubRise doesn't distinguish from a platform
    // courier here, so we default to DELIVERY which the rest of the
    // app treats as either-or.
    const serviceType: string = order.service_type ?? "delivery";
    const fulfillmentType =
      serviceType === "collection"
        ? "PICKUP"
        : serviceType === "eat_in"
          ? "DINE_IN"
          : "DELIVERY";

    // Pull the delivery address either from the top-level delivery
    // object (when HubRise has one) or from the customer record (Uber
    // Eats sandbox orders ship it there).
    const addressSource =
      delivery && (delivery.address_1 || delivery.postal_code)
        ? delivery
        : customer.address_1 || customer.postal_code
          ? customer
          : null;
    const deliveryAddress = addressSource
      ? {
          line1: addressSource.address_1 ?? "",
          line2: addressSource.address_2 ?? undefined,
          city: addressSource.city ?? "",
          postcode: addressSource.postal_code ?? "",
          country: addressSource.country ?? "GB",
        }
      : undefined;

    const total = parseMoney(order.total);
    // HubRise sends per-line subtotals; sum them for the canonical
    // subtotal because the order-level "total" already includes any
    // fees/discounts which our subtotal field shouldn't.
    const subtotal = items.reduce(
      (acc, it) => acc + (it.totalPrice ?? 0),
      0,
    );

    // HubRise discounts / offers — an array of applied deals. Field
    // naming varies by marketplace (value / amount / price, sometimes
    // negative), so sum the magnitudes. Falls back to a scalar discount
    // field. The order-level `total` is already net of these; we surface
    // the discount so the card + receipt show the offer the customer got
    // (previously hard-coded to 0 and silently dropped).
    const discountList = Array.isArray(order.discounts) ? order.discounts : [];
    const discount =
      Math.abs(
        discountList.reduce(
          // HubRise discount lines carry the amount in `price_off`
          // (a.k.a. `pricing_value` when `pricing_effect == "price_off"`),
          // formatted "5.31 GBP". value/amount/price kept as fallbacks
          // for other marketplaces.
          (acc: number, d: any) =>
            acc +
            parseMoney(
              d?.price_off ??
                d?.pricing_value ??
                d?.value ??
                d?.amount ??
                d?.price ??
                d?.total,
            ),
          0,
        ),
      ) || Math.abs(parseMoney(order.total_discount ?? order.discount ?? 0));

    // Delivery fee (previously hard-coded to 0, so a marketplace delivery
    // charge vanished: the card showed subtotal £16.80 against total £19.80
    // with nothing to account for the £3, and the receipt printed the same
    // hole).
    //
    // HubRise carries fees in a `charges` array — the documented shape is
    // { name, type, price }. Match on either type or name because the naming
    // comes from whichever marketplace filled it in, and HubRise's docs have
    // twice described fields differently from what actually arrives.
    const chargeList: any[] = Array.isArray(order.charges)
      ? order.charges
      : Array.isArray(order.fees)
        ? order.fees
        : [];
    const isDeliveryCharge = (c: any) =>
      /deliver/i.test(String(c?.type ?? "")) || /deliver/i.test(String(c?.name ?? ""));
    const chargedDelivery = chargeList
      .filter(isDeliveryCharge)
      .reduce((acc, c) => acc + parseMoney(c?.price ?? c?.amount ?? c?.value), 0);

    // What the line items, discount and known charges don't account for.
    // Positive means money in the total we can't name.
    const knownCharges = chargeList.reduce(
      (acc, c) => acc + parseMoney(c?.price ?? c?.amount ?? c?.value),
      0,
    );
    const unexplained =
      Math.round((parseMoney(order.total) - (subtotal - discount + knownCharges)) * 100) / 100;

    let deliveryFee = chargedDelivery;
    if (!deliveryFee && unexplained > 0 && fulfillmentType === "DELIVERY") {
      // No charge line named it, but a delivery order whose total exceeds its
      // items has a delivery charge in it — Uber and Deliveroo bill VAT
      // inclusive, so this gap is a fee rather than tax. Inferring beats
      // printing a ticket that doesn't add up. Collection orders get nothing:
      // there, an unexplained gap is a service charge or a tip, not delivery.
      deliveryFee = unexplained;
    }
    if (unexplained > 0 || chargeList.length) {
      // Names the real shape in the log so the next order confirms or
      // corrects the mapping above without needing a payload dump.
      this.logger.log(
        `HubRise charges order=${order.id ?? "?"} channel=${order.channel ?? "?"} ` +
          `subtotal=${subtotal} discount=${discount} total=${parseMoney(order.total)} ` +
          `charges=${JSON.stringify(
            chargeList.map((c) => ({ name: c?.name, type: c?.type, price: c?.price })),
          )} ` +
          `→ deliveryFee=${deliveryFee}${!chargedDelivery && deliveryFee ? " (inferred)" : ""} ` +
          `unexplained=${unexplained}`,
      );
    }

    // Payment hint — HubRise sends payment as either:
    //   { type: "online" | "cash_on_delivery", amount: "..." }      ← spec
    //   { name: "Paid online" | "Cash on delivery", amount: "..." } ← Uber/Deliveroo
    // The `name` is set by the marketplace; HubRise's typed `type` is
    // optional, so we fall through to a name match. Anything that
    // settled at the channel side (Uber Eats / Deliveroo) is fully
    // PAID by the time we see it.
    const firstPayment = (order.payments ?? [])[0] ?? null;
    const payHint =
      `${firstPayment?.type ?? ""} ${firstPayment?.name ?? ""}`.toLowerCase();
    const paymentMethod = firstPayment
      ? /cash/.test(payHint)
        ? "CASH"
        : /online|card|paid/.test(payHint)
          ? "CARD"
          : null
      : null;
    const paymentStatus = firstPayment
      ? /cash on delivery|cash_on_delivery/.test(payHint)
        ? "PENDING"
        : "PAID"
      : "PENDING";

    // Phase AV-4 — derive delivery type from the presence of a real
    // address. The signal that the marketplace is handling delivery
    // itself is that it withholds the customer's address from the
    // restaurant (the courier knows where to go, the kitchen doesn't
    // need to). So: address present → restaurant is delivering
    // (MERCHANT), operator walks the order all the way to delivered.
    // Address absent → marketplace courier (PLATFORM), operator is
    // gated at READY and post-READY transitions arrive via the
    // HubRise delivery.* webhook. Channel alone isn't reliable —
    // Uber Eats / Deliveroo can both be used for "merchant delivery"
    // contracts where the restaurant runs its own riders.
    const hasRealAddress =
      !!deliveryAddress &&
      !!(deliveryAddress.line1 || deliveryAddress.postcode);
    const deliveryType =
      fulfillmentType === "DELIVERY"
        ? hasRealAddress
          ? "MERCHANT"
          : "PLATFORM"
        : null;

    // HubRise multi-brand: the order names the brand/store, but the
    // exact field varies by marketplace + HubRise config. Pull the first
    // non-empty of the likely candidates; OrdersService.ingestCanonical
    // matches it (by name) to one of the tenant's brands and pins the
    // order's brandId so the ticket/board show the right brand instead
    // of the location's default. All raw candidates are kept in metadata
    // so we can see which field actually carried it if a match misses.
    // ORDER MATTERS — brandHint takes the FIRST non-empty candidate.
    // `connection_name` is HubRise's authoritative per-brand field (the
    // connection is named per brand, e.g. "monster burgerz") and MUST rank
    // ahead of the store/catalog/location fields below. Those get populated
    // with NON-brand values once we enrich the envelope with the full order
    // (webhook-ingestion.enrichHubRiseOrderPayload) — before enrichment only
    // connection_name was present, so it drove the hint; after enrichment
    // catalog_name/store_name/location_name started winning and dropped the
    // order onto the location's default brand ("Order Hub"). Keep the explicit
    // brand_name/brand first (if a marketplace ever sets them), then
    // connection_name, then the weaker fallbacks.
    const brandCandidates: Record<string, unknown> = {
      brand_name: order.brand_name,
      brand: typeof order.brand === "string" ? order.brand : order.brand?.name,
      connection_name: order.connection_name,
      customer_list_name: order.customer_list_name,
      catalog_name: order.catalog_name,
      store_name: order.store_name,
      location_name: order.location_name,
      seller_name: order.seller_name,
    };
    const brandHint =
      Object.values(brandCandidates)
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find((v) => v.length > 0) ?? undefined;

    return {
      externalId,
      platform: "HUBRISE",
      displayId: order.collection_code ?? order.ref ?? null,
      orderSource: originPlatform as any,
      integrationSource: "HUBRISE",
      viaHubrise: true,
      fulfillmentType: fulfillmentType as any,
      // Phase AV-3 — anonymised-call PIN (phoneAccessCode). HubRise's
      // marketplace partners (Uber Eats, Deliveroo) mask the
      // customer's phone through a routing number that needs this
      // code to dial out. Cast through `as any` because the shared
      // CanonicalOrder.customerInfo type doesn't include the field
      // yet; flowing through as JSON to Order.customerInfo lets the
      // drawer read it without churning the cross-package type.
      customerInfo: {
        name: customerName,
        phone: customer.phone ?? undefined,
        email: customer.email ?? undefined,
        phoneAccessCode: customer.phone_access_code ?? undefined,
      } as any,
      deliveryAddress,
      items,
      subtotal,
      taxAmount: 0,
      deliveryFee,
      discount,
      total: total || subtotal,
      // The delivery note — "press the black doorbell", "we're at the rear of
      // the house" — is the one line the driver actually needs, and it never
      // reached our ticket. customer_notes is the ORDER note; HubRise carries
      // the delivery instruction on the customer/delivery record instead, and
      // which key it lands in varies by marketplace. So take the first
      // non-empty candidate, and keep both when a shop has each.
      specialInstructions: joinNotes(
        firstText(order.customer_notes),
        firstText(
          (delivery as any)?.delivery_notes,
          (delivery as any)?.notes,
          (customer as any)?.delivery_notes,
          (customer as any)?.notes,
          (order as any)?.delivery_notes,
        ),
      ),
      // HubRise `expected_time` is the promised ready/ETA time and is set
      // on EVERY order — including ASAP ones (≈ now + prep). It is NOT a
      // "scheduled for later" flag. The order's own `asap` boolean is, so
      // that decides; the time-based guess is only the fallback for channels
      // that omit it. The raw ETA is kept in metadata for reference.
      scheduledFor: (() => {
        if (!order.expected_time) return undefined;
        // HubRise says outright whether the customer asked for it now. That
        // beats guessing from a clock: a busy shop, or a courier the platform
        // has not assigned yet, pushes expected_time an hour out on an order
        // the customer wants as soon as possible — and the 45-minute rule
        // below then marked every one of them Scheduled, on the board and on
        // the printed ticket. Uber Eats and Just Eat orders were arriving as
        // pre-orders in the middle of service.
        if (order.asap === true) return undefined;
        const t = new Date(order.expected_time);
        if (!Number.isFinite(t.getTime())) return undefined;
        // Still needed where asap is absent or false: some channels don't send
        // the flag, and an expected_time well beyond any prep time is the only
        // remaining signal that somebody ordered ahead.
        const SCHEDULE_THRESHOLD_MS = 45 * 60_000;
        return t.getTime() > Date.now() + SCHEDULE_THRESHOLD_MS ? t : undefined;
      })(),
      idempotencyKey: undefined,
      metadata: {
        hubriseOrderId: order.id,
        hubriseChannel: order.channel,
        hubriseConnection: order.connection_name,
        expectedTime: order.expected_time ?? null,
        originPlatform,
        deliveryType,
        collectionCode: order.collection_code,
        // Payment fields stay in metadata until CanonicalOrder gets
        // first-class slots — OrdersService.ingestCanonical promotes
        // them onto the Order row when present.
        paymentMethod,
        paymentStatus,
        // Raw brand-name candidates from the payload — lets us confirm
        // which field carries the brand if the hint ever misses.
        hubriseBrandName: brandHint ?? null,
        hubriseBrandCandidates: brandCandidates,
        // Raw discounts kept for visibility / refinement if a marketplace
        // names the discount amount field differently.
        hubriseDiscounts: discountList,
        // Raw charge lines + whatever the totals still don't account for,
        // kept so a fee we mapped wrong is provable from the order itself.
        hubriseCharges: chargeList,
        hubriseUnexplainedTotal: unexplained,
      },
    };
  }

  private mapChannel(channel: unknown): string | null {
    const s = String(channel ?? "");
    if (!s) return null;
    for (const [re, key] of HubRiseAdapter.CHANNEL_PATTERNS) {
      if (re.test(s)) return key;
    }
    return null;
  }
}

// HubRise serialises money as "<amount> <currency>" strings; strip the
// suffix and parse what's left. Anything we can't parse becomes 0 so a
// malformed field doesn't drop the whole order.
/** First candidate that is a non-blank string, trimmed. */
function firstText(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Both notes when they differ, on one line — the renderer writes this as a
 *  single string, so a newline here would not survive the ticket. */
function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => !!n);
  const unique = kept.filter((n, i) => kept.indexOf(n) === i);
  return unique.length ? unique.join(" — ") : undefined;
}

function parseMoney(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const match = String(value).match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

// Quantities arrive as strings ("1.0") in the order webhook and as
// numbers in some sub-resources. Normalise to a positive integer.
function parseNum(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
