// Phase AU — HubRise webhook adapter.
//
// HubRise hands us the order body directly at the top level (no
// `resource_type` / `resource` wrapper), and money fields come back as
// strings with the currency suffix ("38.70 GBP"). Channel is a plain
// string ("Uber Eats"), not an object. The adapter normalises all of
// that to our canonical Order shape.

import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

@Injectable()
export class HubRiseAdapter extends BaseWebhookAdapter {
  readonly platform = "HUBRISE";

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
    const customerName =
      [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || "HubRise Customer";

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

    // Payment hint — HubRise's `payments[].type` is "online" |
    // "cash_on_delivery" | "house_account" etc. Anything that
    // settled at the channel side (Uber Eats / Deliveroo) shows as
    // online and is fully PAID by the time we see it.
    const firstPayment = (order.payments ?? [])[0] ?? null;
    const paymentMethod =
      firstPayment?.type === "cash_on_delivery"
        ? "CASH"
        : firstPayment?.type === "online"
          ? "CARD"
          : null;
    const paymentStatus = firstPayment ? "PAID" : "PENDING";

    return {
      externalId,
      platform: "HUBRISE",
      displayId: order.collection_code ?? order.ref ?? null,
      orderSource: originPlatform as any,
      integrationSource: "HUBRISE",
      viaHubrise: true,
      fulfillmentType: fulfillmentType as any,
      customerInfo: {
        name: customerName,
        phone: customer.phone ?? undefined,
        email: customer.email ?? undefined,
      },
      deliveryAddress,
      items,
      subtotal,
      taxAmount: 0,
      deliveryFee: 0,
      discount: 0,
      total: total || subtotal,
      specialInstructions: order.customer_notes ?? undefined,
      scheduledFor: order.expected_time
        ? new Date(order.expected_time)
        : undefined,
      idempotencyKey: undefined,
      metadata: {
        hubriseOrderId: order.id,
        hubriseChannel: order.channel,
        hubriseConnection: order.connection_name,
        originPlatform,
        collectionCode: order.collection_code,
        // Payment fields stay in metadata until CanonicalOrder gets
        // first-class slots — OrdersService.ingestCanonical promotes
        // them onto the Order row when present.
        paymentMethod,
        paymentStatus,
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
