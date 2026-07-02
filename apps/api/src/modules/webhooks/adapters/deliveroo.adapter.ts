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

    // Deliveroo money (verified against the live Orders API): objects of
    // { fractional: 1140, currency_code: "GBP" } — integer minor units.
    // Older/legacy shapes used { amount: "12.50" } strings or bare pence
    // integers, so all three are handled. Output is pounds.
    const parseMoney = (val: unknown): number => {
      if (!val) return 0;
      if (typeof val === "number") return val > 100 ? val / 100 : val; // pence heuristic
      if (typeof val === "object") {
        const o = val as Record<string, any>;
        if (o.fractional !== undefined) return Number(o.fractional) / 100;
        if (o.amount !== undefined) return parseFloat(String(o.amount)) || 0;
      }
      return 0;
    };

    const items = (order.items ?? []).map((item: any) => {
      const qty = item.quantity ?? item.count ?? 1;
      const unit = parseMoney(
        item.unit_price ??
          item.menu_unit_price ??
          item.unit_price_including_tax,
      );
      const total = parseMoney(
        item.total_price ??
          item.total_including_tax ??
          item.total_price_with_addons,
      );
      return {
        name: item.name ?? item.operational_name ?? "Item",
        quantity: qty,
        unitPrice: unit || (qty ? total / qty : 0),
        totalPrice: total || unit * qty,
        // Live Orders API nests selections under item.modifiers[]; the older
        // shape grouped them under modifier_groups[].modifiers[].
        modifiers: [
          ...(item.modifiers ?? []).map((m: any) => ({
            name: m.name ?? m.operational_name ?? "Modifier",
            price: parseMoney(m.unit_price ?? m.menu_unit_price ?? m.total_price),
            quantity: m.quantity ?? m.count ?? 1,
          })),
          ...(item.modifier_groups ?? []).flatMap((g: any) =>
            (g.modifiers ?? []).map((m: any) => ({
              name: m.name,
              price: parseMoney(m.unit_price),
              quantity: m.quantity ?? m.count ?? 1,
            })),
          ),
        ],
        notes: item.notes ?? null,
      };
    });

    const customer = order.customer ?? {};
    // Support both name layouts: combined name field and first_name/last_name
    const fullName = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
    const delivery = order.delivery ?? order.fulfillment?.delivery ?? {};
    const customerName =
      customer.name ?? (fullName || delivery.customer_name || "Deliveroo Customer");
    // Live Orders API: masked callback number + the access code the carrier
    // needs to route the call to this order. On restaurant-fulfillment
    // (own-fleet) orders these ride on the delivery object rather than
    // customer, so probe both.
    const customerPhone =
      customer.contact_number ??
      customer.contact_phone_number ??
      customer.phone_number ??
      customer.phone ??
      delivery.contact_number ??
      delivery.contact_phone_number ??
      delivery.phone_number ??
      undefined;
    const phoneAccessCode =
      customer.contact_access_code ??
      customer.phone_access_code ??
      delivery.contact_access_code ??
      delivery.phone_access_code ??
      undefined;

    // Address arrives in several layouts: an object under delivery.address
    // (address_line_1 / address1 / line1 / street), a plain string, or on
    // the order itself.
    const rawAddress =
      delivery.address ?? order.delivery_address ?? order.address ?? {};
    const address =
      typeof rawAddress === "string" ? { line1: rawAddress } : rawAddress;
    const addrLine1 =
      address.address_line_1 ??
      address.address1 ??
      address.line1 ??
      address.line_1 ??
      address.street_address ??
      address.street ??
      "";
    const hasAddress = !!addrLine1;

    // fulfillment_type (verified): "deliveroo" = Deliveroo rider delivers,
    // "customer" = customer collects, "restaurant" = merchant's own fleet
    // delivers, "table_service" = dine-in. Legacy pickup hints kept as
    // fallbacks for older payloads.
    const ft = String(order.fulfillment_type ?? "").toLowerCase();
    const isPickup =
      ft === "customer" ||
      ft === "customer_collection" ||
      ft === "collection" ||
      ft === "pickup" ||
      delivery.type === "pickup" ||
      order.fulfillment?.method === "pickup";
    const fulfillmentType =
      ft === "table_service"
        ? "DINE_IN"
        : isPickup
          ? "PICKUP"
          : ft === "restaurant"
            ? "DELIVERY"
            : "PLATFORM_COURIER";
    // Who drives the post-READY lifecycle: Deliveroo's rider (PLATFORM,
    // rider webhooks advance it) vs the restaurant's own fleet (MERCHANT,
    // operator advances it on the dashboard). Promoted onto Order.deliveryType
    // by ingestCanonical.
    const deliveryType =
      fulfillmentType === "PLATFORM_COURIER"
        ? "PLATFORM"
        : ft === "restaurant"
          ? "MERCHANT"
          : undefined;

    return {
      externalId,
      platform: "DELIVEROO",
      displayId:
        order.display_reference ??
        order.display_id ??
        (order.order_number != null ? String(order.order_number) : null),
      orderSource: "DELIVEROO",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType,
      customerInfo: {
        name: customerName,
        phone: customerPhone,
        email: customer.email ?? undefined,
        // Carrier PIN for the masked callback number — the dashboard's
        // "call customer" flow needs it (same pattern as HubRise).
        ...(phoneAccessCode ? { phoneAccessCode } : {}),
      } as any,
      deliveryAddress: hasAddress
        ? {
            line1: addrLine1,
            line2:
              address.address_line_2 ??
              address.address2 ??
              address.line2 ??
              undefined,
            city: address.city ?? address.town ?? "",
            postcode:
              address.postcode ?? address.post_code ?? address.zip_code ?? "",
            country: "GB",
            ...(delivery.location?.latitude != null
              ? {
                  coordinates: {
                    lat: Number(delivery.location.latitude),
                    lng: Number(delivery.location.longitude),
                  },
                }
              : {}),
          }
        : undefined,
      items,
      subtotal: parseMoney(
        order.partner_order_subtotal ??
          order.subtotal ??
          order.subtotal_including_tax,
      ),
      taxAmount: parseMoney(order.tax ?? null),
      deliveryFee: parseMoney(delivery.delivery_fee ?? order.delivery_charge),
      discount: parseMoney(order.offer_discount ?? order.discount ?? null),
      total: parseMoney(
        order.partner_order_total ?? order.total_price ?? order.total,
      ),
      specialInstructions: order.notes ?? order.special_instructions ?? undefined,
      scheduledFor: order.scheduled_for ? new Date(order.scheduled_for) : undefined,
      idempotencyKey: undefined,
      metadata: {
        rawOrderId: order.id,
        restaurantId: order.restaurant?.id,
        deliverooFulfillmentType: ft || null,
        ...(deliveryType ? { deliveryType } : {}),
        ...(phoneAccessCode ? { phoneAccessCode } : {}),
        // Deliveroo orders are prepaid on the platform unless cash is due on
        // delivery/collection. Promoted onto the Order row by ingestCanonical
        // so the board + receipt don't show "*** UNPAID ***".
        paymentMethod: parseMoney(order.cash_due) > 0 ? "CASH" : "CARD",
        paymentStatus: parseMoney(order.cash_due) > 0 ? "PENDING" : "PAID",
      },
    };
  }
}
