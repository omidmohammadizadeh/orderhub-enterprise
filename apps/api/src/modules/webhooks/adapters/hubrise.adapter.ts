import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";
import type { CanonicalOrder } from "@orderhub/shared";
import { BaseWebhookAdapter } from "./base.adapter";

// HubRise is an aggregator layer — orders arrive normalized but still need
// mapping to our canonical format. viaHubrise is always true here.
// The actual orderSource depends on the originating channel reported by HubRise.
@Injectable()
export class HubRiseAdapter extends BaseWebhookAdapter {
  readonly platform = "HUBRISE";

  private static readonly PLATFORM_MAP: Record<string, string> = {
    uber_eats: "UBER_EATS",
    deliveroo: "DELIVEROO",
    just_eat: "JUST_EAT",
  };

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ) {
    // HubRise uses HMAC-SHA256 hex in X-HubRise-Signature
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
    return p?.order?.id ?? (headers["x-hubrise-request-id"] as string) ?? "";
  }

  normalize(rawPayload: unknown, _locationId: string): CanonicalOrder | null {
    const p = rawPayload as Record<string, any>;
    if (p?.resource_type !== "order") return null;

    const order = p?.resource ?? {};
    const externalId: string = order.id;
    if (!externalId) return null;

    // Detect originating platform from HubRise channel name
    const channelName: string = (order.channel?.name ?? "").toLowerCase();
    const originPlatform =
      Object.entries(HubRiseAdapter.PLATFORM_MAP).find(([key]) =>
        channelName.includes(key),
      )?.[1] ?? "HUBRISE";

    const items = (order.items ?? []).map((item: any) => ({
      name: item.product_name ?? item.sku_name ?? "Item",
      quantity: item.quantity ?? 1,
      unitPrice: Number(item.price ?? 0),
      totalPrice: Number(item.price ?? 0) * (item.quantity ?? 1),
      modifiers: (item.options ?? []).map((o: any) => ({
        name: o.name,
        price: Number(o.price ?? 0),
        quantity: o.quantity ?? 1,
      })),
      notes: item.customer_notes ?? null,
    }));

    const customer = order.customer ?? {};
    const delivery = order.delivery ?? {};

    const serviceType: string = order.service_type ?? "delivery";
    const fulfillmentType =
      serviceType === "collection"
        ? "PICKUP"
        : serviceType === "eat_in"
          ? "DINE_IN"
          : "MERCHANT_DELIVERY";

    return {
      externalId,
      platform: "HUBRISE",
      displayId: order.collection_code ?? null,
      orderSource: originPlatform as any,
      integrationSource: "HUBRISE",
      viaHubrise: true,
      fulfillmentType: fulfillmentType as any,
      customerInfo: {
        name: `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || "HubRise Customer",
        phone: customer.phone ?? undefined,
        email: customer.email ?? undefined,
      },
      deliveryAddress:
        delivery.address_1
          ? {
              line1: delivery.address_1,
              line2: delivery.address_2 ?? undefined,
              city: delivery.city ?? "",
              postcode: delivery.postal_code ?? "",
              country: "GB",
            }
          : undefined,
      items,
      subtotal: Number(order.total ?? 0),
      taxAmount: 0,
      deliveryFee: 0,
      discount: 0,
      total: Number(order.total ?? 0),
      specialInstructions: order.customer_notes ?? undefined,
      scheduledFor: order.expected_time ? new Date(order.expected_time) : undefined,
      idempotencyKey: undefined,
      metadata: {
        hubriseOrderId: order.id,
        hubriseChannel: order.channel?.name,
        originPlatform,
      },
    };
  }
}
