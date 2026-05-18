import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

@Injectable()
export class UberEatsAdapter extends BaseWebhookAdapter {
  readonly platform = "UBER_EATS";

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ) {
    const sig = headers["x-uber-signature"] as string | undefined;
    if (!sig) return { valid: false, reason: "Missing x-uber-signature header" };

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const valid = crypto.timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex"),
    );
    return { valid };
  }

  extractEventId(
    rawPayload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): string {
    const p = rawPayload as Record<string, any>;
    return (headers["x-uber-request-uuid"] as string) ?? p?.meta?.resource_href ?? p?.order_id ?? "";
  }

  normalize(rawPayload: unknown, locationId: string): CanonicalOrder | null {
    const p = rawPayload as Record<string, any>;

    // Only process order creation events
    if (p?.event_type !== "orders.notification" && p?.type !== "ORDER_CREATED") {
      return null;
    }

    const order = p?.order ?? p;
    const externalId: string = order.id ?? order.order_id;
    if (!externalId) return null;

    const items = (order.cart?.items ?? []).map((item: any) => ({
      name: item.title ?? item.name,
      quantity: item.quantity ?? 1,
      unitPrice: (item.base_unit_price?.amount ?? 0) / 100,
      totalPrice: (item.price?.amount ?? 0) / 100,
      modifiers: (item.selected_modifier_groups ?? []).flatMap((g: any) =>
        (g.selected_items ?? []).map((m: any) => ({
          name: m.title ?? m.name,
          price: (m.price?.amount ?? 0) / 100,
          quantity: m.quantity ?? 1,
        })),
      ),
      notes: item.special_instructions ?? null,
    }));

    const delivery = order.delivery_information;
    const customer = order.eater ?? {};
    const pricing = order.payment?.charges ?? {};

    return {
      externalId,
      platform: "UBER_EATS",
      displayId: order.display_id ?? null,
      orderSource: "UBER_EATS",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType: delivery?.type === "PICKUP" ? "PICKUP" : "PLATFORM_COURIER",
      customerInfo: {
        name: `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || "Uber Eats Customer",
        phone: customer.phone ?? undefined,
        email: undefined,
      },
      deliveryAddress: delivery?.location
        ? {
            line1: delivery.location.address ?? "",
            city: delivery.location.city ?? "",
            postcode: delivery.location.zip_code ?? "",
            country: "GB",
          }
        : undefined,
      items,
      subtotal: (pricing.subtotal?.amount ?? 0) / 100,
      taxAmount: (pricing.tax?.amount ?? 0) / 100,
      deliveryFee: (pricing.delivery_fee?.amount ?? 0) / 100,
      discount: (pricing.promotion?.amount ?? 0) / 100,
      total: (pricing.total?.amount ?? 0) / 100,
      specialInstructions: order.special_instructions ?? undefined,
      scheduledFor: order.scheduled_at ? new Date(order.scheduled_at) : undefined,
      idempotencyKey: undefined,
      metadata: { rawOrderId: order.id, storeId: order.restaurant_id },
    };
  }
}
