// DEV-ONLY: answers every API call from sample data (see data.ts). Orders live
// in memory and walk themselves through the real status sequence on a timer so
// the tracking screen can be shown end to end.

import type {
  AddressBody,
  AuthResult,
  CheckoutBody,
  CheckoutResult,
  Customer,
  OrderDetail,
  OrderStatusName,
  OrderSummary,
  SavedAddress,
  ShopMenu,
} from "../types";
import { MOCK_DESTINATION, MOCK_SHOP_POINT, mockCustomer, mockShops, mockStore } from "./data";

const delay = <T,>(value: T, ms = 450) => new Promise<T>((r) => setTimeout(() => r(value), ms));

type MockOrder = { body: CheckoutBody; placedAt: number; shopName: string; listingId: string; displayId: string };
const orders = new Map<string, MockOrder>();

// One finished order so "Orders" and "Order again" have something to show.
orders.set("mock-order-past", {
  body: {
    idempotencyKey: "past",
    fulfillmentType: "DELIVERY",
    items: [{ menuItemId: "x", name: "Pepperoni Pizza", quantity: 1, unitPrice: 10.5, modifiers: [] }],
    subtotal: 10.5,
    total: 11.99,
  },
  placedAt: Date.now() - 3 * 24 * 3600_000,
  shopName: "Pizza Pizza",
  listingId: "mock-pizza-pizza",
  displayId: "EFL-4821",
});

let me: Customer = { ...mockCustomer };

export const getShops = () => delay(mockShops, 600);

export const getShopMenu = (listingId: string): Promise<ShopMenu> => {
  const shop = mockShops.find((s) => s.id === listingId) ?? mockShops[0]!;
  return delay({
    listing: {
      id: shop.id,
      heroImageUrl: shop.heroImageUrl,
      logoUrl: null,
      description: null,
      cuisines: shop.cuisines,
      acceptsDelivery: shop.delivery.available,
      acceptsCollection: shop.collection.available,
    },
    store: { ...mockStore, brand: { ...mockStore.brand, name: shop.name }, isOpen: shop.isOpen },
  });
};

export const checkout = (listingId: string, body: CheckoutBody): Promise<CheckoutResult> => {
  const id = `mock-order-${Date.now()}`;
  const displayId = `EFL-${Math.floor(1000 + Math.random() * 9000)}`;
  const shop = mockShops.find((s) => s.id === listingId);
  orders.set(id, { body, placedAt: Date.now(), shopName: shop?.name ?? "Sample shop", listingId, displayId });
  return delay(
    {
      orderId: id,
      displayId,
      total: body.total,
      clientSecret: null,
      stripeAccountId: null,
      amountPence: Math.round(body.total * 100),
      checkoutUrl: null,
    },
    900,
  );
};

/** Seconds since placing → where a real order would be by now. */
function statusAt(seconds: number, delivery: boolean): OrderStatusName {
  if (seconds < 6) return "RECEIVED";
  if (seconds < 12) return "ACCEPTED";
  if (seconds < 22) return "PREPARING";
  if (!delivery) return seconds < 40 ? "READY" : "COLLECTED";
  if (seconds < 120) return "OUT_FOR_DELIVERY";
  return "DELIVERED";
}

const iso = (t: number) => new Date(t).toISOString();

export const getMyOrder = (orderId: string): Promise<OrderDetail> => {
  const o = orders.get(orderId);
  if (!o) return Promise.reject(new Error("Order not found"));
  const delivery = o.body.fulfillmentType === "DELIVERY";
  const s = (Date.now() - o.placedAt) / 1000;
  const status = statusAt(s, delivery);
  const at = (sec: number) => (s >= sec ? iso(o.placedAt + sec * 1000) : null);
  return delay(
    {
      id: orderId,
      displayId: o.displayId,
      status,
      fulfillmentType: o.body.fulfillmentType,
      receivedAt: iso(o.placedAt),
      acceptedAt: at(6),
      preparingAt: at(12),
      readyAt: at(22),
      outForDeliveryAt: delivery ? at(22) : null,
      deliveredAt: delivery ? at(120) : null,
      estimatedReadyAt: iso(o.placedAt + (delivery ? 32 : 15) * 60_000),
      total: o.body.total,
      location: { name: o.shopName, currency: "GBP" },
      items: o.body.items.map((it, i) => ({ id: String(i), name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
      destination: delivery ? MOCK_DESTINATION : null,
      shop: MOCK_SHOP_POINT,
      driver: status === "OUT_FOR_DELIVERY" ? { name: "Daniel", lat: null, lng: null, lastPingAt: iso(Date.now()) } : null,
      driverEtaMinutes: status === "OUT_FOR_DELIVERY" ? Math.max(1, Math.ceil((120 - s) / 15)) : null,
      deliveryPin: delivery ? "4821" : null,
      handedOver: status === "DELIVERED",
    },
    250,
  );
};

export const getMyOrders = (): Promise<OrderSummary[]> =>
  delay(
    [...orders.entries()]
      .sort((a, b) => b[1].placedAt - a[1].placedAt)
      .map(([id, o]) => ({
        id,
        displayId: o.displayId,
        status: statusAt((Date.now() - o.placedAt) / 1000, o.body.fulfillmentType === "DELIVERY"),
        total: o.body.total,
        createdAt: iso(o.placedAt),
        fulfillmentType: o.body.fulfillmentType,
        location: { name: o.shopName, eflListing: { id: o.listingId } },
        brand: { name: o.shopName },
      })),
  );

export const startPhone = (phone: string) => {
  pendingPhone = `+44${phone.replace(/\D/g, "").replace(/^0/, "")}`;
  return delay({ sent: true as const, phone: `07••• •••${phone.replace(/\D/g, "").slice(-3)}` });
};

let pendingPhone = "+447700900482";

export const verifyPhone = (code: string) => {
  if (code.length !== 6) return Promise.reject(new Error("That code isn't right."));
  markVerified(pendingPhone);
  return delay({ verified: true as const }, 600);
};

export const signIn = (): Promise<AuthResult> => delay({ accessToken: "mock-token", customer: me }, 700);

export const getMe = () => delay({ ...me, accessToken: "mock-token" }, 200);

export const updateMe = (patch: Partial<Customer>) => {
  me = { ...me, ...patch };
  return delay(me);
};

// ── Account flags, addresses, favourites (in memory) ───────────────────────

let flags = { phone: null as string | null, phoneVerified: false, marketingOptIn: false };

export const getEflMe = () => delay({ ...flags }, 200);

export const setMarketing = (optIn: boolean) => {
  flags = { ...flags, marketingOptIn: optIn };
  return delay({ eflMarketingOptIn: optIn }, 200);
};

/** Called by verifyPhone so getEflMe reflects the check, as the API does. */
function markVerified(phone: string) {
  flags = { ...flags, phone, phoneVerified: true };
}

let savedAddresses: SavedAddress[] = [
  {
    id: "mock-addr-home",
    label: "Home",
    line1: "14 Grey Street",
    line2: "Flat 3",
    city: "Newcastle upon Tyne",
    postcode: "NE1 6AE",
    latitude: 54.97222,
    longitude: -1.61213,
    instructions: "Ring the bell",
    isDefault: true,
  },
];

export const getAddresses = () => delay([...savedAddresses], 250);

export const addAddress = (body: AddressBody) => {
  const isDefault = body.isDefault ?? savedAddresses.length === 0;
  const row: SavedAddress = {
    id: `mock-addr-${Date.now()}`,
    label: body.label ?? null,
    line1: body.line1,
    line2: body.line2 ?? null,
    city: body.city,
    postcode: body.postcode,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    instructions: body.instructions ?? null,
    isDefault,
  };
  savedAddresses = [row, ...savedAddresses.map((a) => (isDefault ? { ...a, isDefault: false } : a))];
  return delay(row, 300);
};

export const updateAddress = (id: string, body: Partial<AddressBody>) => {
  savedAddresses = savedAddresses.map((a) =>
    a.id === id ? { ...a, ...body } as SavedAddress : body.isDefault ? { ...a, isDefault: false } : a,
  );
  return delay(savedAddresses.find((a) => a.id === id)!, 250);
};

export const deleteAddress = (id: string) => {
  const wasDefault = savedAddresses.find((a) => a.id === id)?.isDefault;
  savedAddresses = savedAddresses.filter((a) => a.id !== id);
  if (wasDefault && savedAddresses[0]) savedAddresses[0] = { ...savedAddresses[0], isDefault: true };
  return delay({ ok: true as const }, 250);
};

let favourites: string[] = ["mock-pizza-pizza"];

export const getFavourites = () => delay([...favourites], 200);

export const setFavourite = (listingId: string, on: boolean) => {
  favourites = on ? [listingId, ...favourites.filter((f) => f !== listingId)] : favourites.filter((f) => f !== listingId);
  return delay({ ok: true as const }, 200);
};
