import { brand } from "./brand";

const base = `${brand.apiUrl}/v1`;

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export type OrderStatus =
  | "PENDING"
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "PENDING_DISPATCH"
  | "ASSIGNED_DRIVER"
  | "ACCEPTED_BY_DRIVER"
  | "RIDER_ARRIVED"
  | "OUT_FOR_DELIVERY"
  | "DISPATCHED"
  | "COMPLETED"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED";

export type FulfillmentType = "PICKUP" | "DELIVERY" | "DINE_IN" | "MERCHANT_DELIVERY" | "PLATFORM_COURIER";

/** The public tracking payload — GET /v1/ordering/orders/:id/status. Only
 *  the fields this app reads. */
export type OrderStatusPayload = {
  id: string;
  displayId: string | null;
  orderNumber: string | number | null;
  status: OrderStatus;
  paymentMethod: string | null;
  paymentStatus: string | null;
  fulfillmentType: FulfillmentType;
  estimatedReadyAt: string | null;
  scheduledFor: string | null;
  receivedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  total: number | string;
  location: { name: string; currency: string | null } | null;
  items: { id: string; name: string; quantity: number; unitPrice: number | string }[];
  /** Live delivery tracking: the driver's last GPS fix (own-fleet drivers),
   *  the delivery address and the shop, each null when unknown. */
  driver: { name: string; phone: string | null; lat: number | null; lng: number | null; lastPingAt: string | null } | null;
  destination: { lat: number; lng: number } | null;
  shop?: { lat: number; lng: number } | null;
};

export async function getOrderStatus(orderId: string): Promise<OrderStatusPayload> {
  const res = await fetch(`${base}/ordering/orders/${encodeURIComponent(orderId)}/status`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export type Platform = "ios" | "android";

export function registerDevice(args: {
  expoToken: string;
  platform: Platform;
  appId: string;
  marketingOptIn: boolean;
}) {
  return post("/customer-push/register-device", {
    expoToken: args.expoToken,
    brandId: brand.brandId,
    ...(brand.locationId ? { locationId: brand.locationId } : {}),
    platform: args.platform,
    appId: args.appId,
    marketingOptIn: args.marketingOptIn,
  });
}

export function setMarketingPreference(expoToken: string, marketingOptIn: boolean) {
  return post("/customer-push/preferences", { endpoint: expoToken, marketingOptIn });
}

export function subscribeToOrder(args: {
  orderId: string;
  expoToken: string;
  platform: Platform;
  appId: string;
  trackPath: string;
}) {
  return post("/customer-push/subscribe", args);
}

/** The bits of GET /v1/ordering/store/:slug the native Home screen shows. */
export type StoreInfo = {
  isOpen: boolean;
  busy: unknown;
  location: {
    name: string;
    phone: string | null;
    addressLine1: string | null;
    postcode: string | null;
    currency: string | null;
    timezone: string | null;
    openingHours: Record<string, { from: string; to: string }[]> | null;
    currentPrepTime: number | null;
  };
  brand: { name: string; logoUrl: string | null } | null;
  directConfig: {
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
    deliveryPrepMinutes: number | null;
    collectionPrepMinutes: number | null;
  } | null;
  menu: { bannerImage: string | null; heroImage: string | null; logoImage: string | null } | null;
  campaign: { name: string; type: string; percentageOff: number | null; amountOff: number | null; minOrder: number | null } | null;
  topSellers: { id: string; name: string; description: string | null; basePrice: string | number; imageUrl: string | null }[];
};

export async function getStoreInfo(): Promise<StoreInfo> {
  const path = brand.storefrontUrl.replace(/^https?:\/\/[^/]+/, "");
  const slug = path.match(/^\/order\/([^/?#]+)/)?.[1];
  const pin = path.match(/[?&]brand=([^&#]+)/)?.[1];
  const res = await fetch(`${base}/ordering/store/${slug}${pin ? `?brand=${pin}` : ""}`);
  if (!res.ok) throw new Error(`store ${res.status}`);
  return res.json();
}

/** Menu images come back either absolute or relative to the API host. */
export function imageUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  if (/^https?:\/\//.test(src)) return src;
  if (src.startsWith("/")) return `${brand.apiUrl.replace(/\/api$/, "")}${src}`;
  return null;
}
