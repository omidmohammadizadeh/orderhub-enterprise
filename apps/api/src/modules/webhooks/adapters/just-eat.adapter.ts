import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

@Injectable()
export class JustEatAdapter extends BaseWebhookAdapter {
  readonly platform = "JUST_EAT";

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ) {
    // Just Eat uses HMAC-SHA256 with base64 encoding
    const sig = headers["x-je-signature"] as string | undefined;
    if (!sig) return { valid: false, reason: "Missing x-je-signature header" };

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");

    const valid = crypto.timingSafeEqual(
      Buffer.from(sig, "base64"),
      Buffer.from(expected, "base64"),
    );
    return { valid };
  }

  extractEventId(
    rawPayload: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): string {
    const p = rawPayload as Record<string, any>;
    return p?.order?.order_id ?? p?.orderId ?? "";
  }

  normalize(rawPayload: unknown, _locationId: string): CanonicalOrder | null {
    const p = rawPayload as Record<string, any>;
    // Just Eat sends different event types; only handle new orders
    if (p?.event !== "order_placed" && !p?.order) return null;

    const order = p?.order ?? p;
    const externalId: string = String(order.order_id ?? order.id ?? "");
    if (!externalId) return null;

    const items = (order.order_lines ?? order.items ?? []).map((item: any) => ({
      name: item.name,
      quantity: item.quantity ?? 1,
      unitPrice: Number(item.unit_price ?? 0),
      totalPrice: Number(item.unit_price ?? 0) * (item.quantity ?? 1),
      modifiers: (item.addons ?? item.options ?? []).map((m: any) => ({
        name: m.name,
        price: Number(m.price ?? 0),
        quantity: m.quantity ?? 1,
      })),
      notes: item.instructions ?? null,
    }));

    const customer = order.customer ?? {};
    const delivery = order.delivery ?? {};

    return {
      externalId,
      platform: "JUST_EAT",
      displayId: String(order.order_id ?? ""),
      orderSource: "JUST_EAT",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType:
        order.service_type === "collection"
          ? "PICKUP"
          : "PLATFORM_COURIER",
      customerInfo: {
        name:
          `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() ||
          "Just Eat Customer",
        phone: customer.phone_number ?? undefined,
        email: customer.email ?? undefined,
      },
      deliveryAddress:
        delivery.address
          ? {
              line1: delivery.address.address1 ?? "",
              line2: delivery.address.address2 ?? undefined,
              city: delivery.address.city ?? "",
              postcode: delivery.address.postcode ?? "",
              country: "GB",
            }
          : undefined,
      items,
      subtotal: Number(order.total_price ?? 0) - Number(order.delivery_charge ?? 0),
      taxAmount: 0,
      deliveryFee: Number(order.delivery_charge ?? 0),
      discount: Number(order.discount_amount ?? 0),
      total: Number(order.total_price ?? 0),
      specialInstructions: order.notes ?? undefined,
      scheduledFor: order.due_date ? new Date(order.due_date) : undefined,
      idempotencyKey: undefined,
      metadata: { rawOrderId: order.order_id, restaurantId: order.restaurant_id },
    };
  }
}
