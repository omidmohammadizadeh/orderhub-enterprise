import type { CanonicalOrder } from "@orderhub/shared";

// Raw Uber Eats webhook payload shape (partial — extend as needed)
export interface UberEatsOrderPayload {
  order_id: string;
  display_id: string;
  eater: {
    first_name: string;
    last_name: string;
    phone: string;
  };
  delivery_address?: {
    street_address: [string, string?];
    city: string;
    zip: string;
    country: string;
    latitude: number;
    longitude: number;
  };
  cart: {
    items: UberEatsItem[];
    special_instructions?: string;
  };
  payment: {
    charges: {
      total: { amount: number; currency_code: string };
      sub_total: { amount: number };
      tax: { amount: number };
      delivery_fee: { amount: number };
      discount: { amount: number };
    };
  };
  placed_at: string;
  estimated_ready_for_pickup_at?: string;
  scheduled_for?: string;
  order_type: "DELIVERY_ORDER" | "PICKUP_ORDER" | "DINE_IN_ORDER";
}

export interface UberEatsItem {
  id: string;
  title: string;
  quantity: number;
  price: { amount: number };
  selected_modifier_groups?: Array<{
    title: string;
    selected_items: Array<{ title: string; price: { amount: number } }>;
  }>;
  special_instructions?: string;
}

// Converts Uber Eats payload → canonical CanonicalOrder
// This mapper is the ONLY place Uber Eats-specific field names appear.
// The rest of the platform speaks CanonicalOrder.
export function mapUberEatsOrder(raw: UberEatsOrderPayload): CanonicalOrder {
  const toDecimal = (amount: number) => amount / 100; // Uber sends cents

  const items = raw.cart.items.map((item) => ({
    externalId: item.id,
    name: item.title,
    quantity: item.quantity,
    unitPrice: toDecimal(item.price.amount),
    totalPrice: toDecimal(item.price.amount) * item.quantity,
    modifiers:
      item.selected_modifier_groups?.flatMap((g) =>
        g.selected_items.map((m) => ({
          name: m.title,
          price: toDecimal(m.price.amount),
          quantity: 1,
        })),
      ) ?? [],
    notes: item.special_instructions,
  }));

  const charges = raw.payment.charges;
  const da = raw.delivery_address;

  return {
    externalId: raw.order_id,
    platform: "UBER_EATS",
    displayId: raw.display_id,
    type:
      raw.order_type === "DELIVERY_ORDER"
        ? "DELIVERY"
        : raw.order_type === "PICKUP_ORDER"
          ? "COLLECTION"
          : "DINE_IN",
    customerInfo: {
      name: `${raw.eater.first_name} ${raw.eater.last_name}`.trim(),
      phone: raw.eater.phone,
    },
    deliveryAddress: da
      ? {
          line1: da.street_address[0],
          line2: da.street_address[1],
          city: da.city,
          postcode: da.zip,
          country: da.country,
          coordinates: { lat: da.latitude, lng: da.longitude },
        }
      : undefined,
    items,
    subtotal: toDecimal(charges.sub_total.amount),
    taxAmount: toDecimal(charges.tax.amount),
    deliveryFee: toDecimal(charges.delivery_fee.amount),
    discount: toDecimal(charges.discount.amount),
    total: toDecimal(charges.total.amount),
    specialInstructions: raw.cart.special_instructions,
    scheduledFor: raw.scheduled_for ? new Date(raw.scheduled_for) : undefined,
    metadata: { uberEatsOrderId: raw.order_id },
  };
}
