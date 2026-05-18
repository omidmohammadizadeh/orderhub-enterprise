import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

@Injectable()
export class DeliverooAdapter extends BaseWebhookAdapter {
  readonly platform = "DELIVEROO";

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ) {
    const sig = headers["deliveroo-signature"] as string | undefined;
    if (!sig) return { valid: false, reason: "Missing deliveroo-signature header" };

    const expected = `sha256=${crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")}`;

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
    return p?.event?.id ?? p?.order?.id ?? "";
  }

  normalize(rawPayload: unknown, locationId: string): CanonicalOrder | null {
    const p = rawPayload as Record<string, any>;
    if (p?.event?.type !== "order.created") return null;

    const order = p?.order ?? {};
    const externalId: string = order.id;
    if (!externalId) return null;

    const items = (order.items ?? []).map((item: any) => ({
      name: item.name,
      quantity: item.count ?? 1,
      unitPrice: (item.total_price_with_addons ?? 0) / (item.count ?? 1) / 100,
      totalPrice: (item.total_price_with_addons ?? 0) / 100,
      modifiers: (item.modifier_groups ?? []).flatMap((g: any) =>
        (g.modifiers ?? []).map((m: any) => ({
          name: m.name,
          price: (m.unit_price ?? 0) / 100,
          quantity: m.count ?? 1,
        })),
      ),
      notes: item.notes ?? null,
    }));

    const customer = order.customer ?? {};
    const delivery = order.fulfillment?.delivery ?? {};

    return {
      externalId,
      platform: "DELIVEROO",
      displayId: order.display_id ?? null,
      orderSource: "DELIVEROO",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType: order.fulfillment?.method === "pickup" ? "PICKUP" : "PLATFORM_COURIER",
      customerInfo: {
        name: customer.name ?? "Deliveroo Customer",
        phone: customer.phone_number ?? undefined,
        email: customer.email ?? undefined,
      },
      deliveryAddress: delivery.address
        ? {
            line1: delivery.address.address1 ?? "",
            line2: delivery.address.address2 ?? undefined,
            city: delivery.address.city ?? "",
            postcode: delivery.address.postcode ?? "",
            country: "GB",
          }
        : undefined,
      items,
      subtotal: (order.subtotal ?? 0) / 100,
      taxAmount: 0,
      deliveryFee: (order.delivery_charge ?? 0) / 100,
      discount: (order.discount ?? 0) / 100,
      total: (order.total ?? 0) / 100,
      specialInstructions: order.notes ?? undefined,
      scheduledFor: order.scheduled_for ? new Date(order.scheduled_for) : undefined,
      idempotencyKey: undefined,
      metadata: { rawOrderId: order.id, restaurantId: order.restaurant?.id },
    };
  }
}
