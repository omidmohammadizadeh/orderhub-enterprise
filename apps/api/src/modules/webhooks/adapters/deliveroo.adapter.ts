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

    // Skip non-order events when an explicit event wrapper is present.
    // Deliveroo sends both: { event: { type }, order: {...} } and bare { order: {...} }.
    if (p?.event?.type && p.event.type !== "order.created") return null;

    const order = p?.order ?? {};
    const externalId: string = order.id;
    if (!externalId) return null;

    // Deliveroo amounts arrive as { amount: "12.50" } strings (human-readable pounds)
    // or occasionally as integer pence.  Normalise both to a JS float in pounds.
    const parseMoney = (val: unknown): number => {
      if (!val) return 0;
      if (typeof val === "number") return val > 100 ? val / 100 : val; // pence heuristic
      if (typeof val === "object" && "amount" in (val as object))
        return parseFloat((val as Record<string, string>).amount ?? "0");
      return 0;
    };

    const items = (order.items ?? []).map((item: any) => ({
      name: item.name,
      quantity: item.quantity ?? item.count ?? 1,
      unitPrice: parseMoney(item.unit_price_including_tax ?? item.unit_price),
      totalPrice: parseMoney(item.total_including_tax ?? item.total_price_with_addons),
      modifiers: (item.modifier_groups ?? []).flatMap((g: any) =>
        (g.modifiers ?? []).map((m: any) => ({
          name: m.name,
          price: parseMoney(m.unit_price),
          quantity: m.quantity ?? m.count ?? 1,
        })),
      ),
      notes: item.notes ?? null,
    }));

    const customer = order.customer ?? {};
    // Support both name layouts: combined name field and first_name/last_name
    const fullName = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
    const customerName = customer.name ?? (fullName || "Deliveroo Customer");

    // Delivery address comes in two layouts depending on API version:
    //   v1: order.fulfillment.delivery.address
    //   v2: order.delivery.address
    const delivery = order.delivery ?? order.fulfillment?.delivery ?? {};
    const address = delivery.address ?? {};
    const hasAddress = address.address_line_1 || address.address1;

    const isPickup =
      delivery.type === "pickup" || order.fulfillment?.method === "pickup";

    return {
      externalId,
      platform: "DELIVEROO",
      displayId: order.display_reference ?? order.display_id ?? null,
      orderSource: "DELIVEROO",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType: isPickup ? "PICKUP" : "PLATFORM_COURIER",
      customerInfo: {
        name: customerName,
        phone: customer.phone_number ?? customer.phone ?? undefined,
        email: customer.email ?? undefined,
      },
      deliveryAddress: hasAddress
        ? {
            line1: address.address_line_1 ?? address.address1 ?? "",
            line2: address.address_line_2 ?? address.address2 ?? undefined,
            city: address.city ?? "",
            postcode: address.postcode ?? address.zip_code ?? "",
            country: "GB",
          }
        : undefined,
      items,
      subtotal: parseMoney(order.subtotal_including_tax ?? order.subtotal),
      taxAmount: parseMoney(order.tax ?? null),
      deliveryFee: parseMoney(order.delivery_charge),
      discount: parseMoney(order.discount ?? null),
      total: parseMoney(order.total),
      specialInstructions: order.notes ?? order.special_instructions ?? undefined,
      scheduledFor: order.scheduled_for ? new Date(order.scheduled_for) : undefined,
      idempotencyKey: undefined,
      metadata: { rawOrderId: order.id, restaurantId: order.restaurant?.id },
    };
  }
}
