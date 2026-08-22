import axios from "axios";

// Group ordering — a shared basket several people add to before it becomes
// one order. Every endpoint is public: guests join by link with no account,
// so the share token is the basket's credential.
//
// Bare axios, not the shared apiClient, for the same reason the public
// reservations client uses its own transport: everyone here is a guest with no
// token, and the shared instance's 401 handling would try to refresh a session
// that doesn't exist and bounce them to /login mid-order.
const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "/api",
});

/** What the storefront must store on each line. This is the contract the API
 *  maps into a CreateOrderDto at place time — keep the two in step. */
export interface GroupCartItem {
  name: string;
  unitPrice: number;
  menuItemId?: string;
  notes?: string;
  modifiers?: Array<{ name: string; price: number; quantity?: number }>;
}

export interface GroupOrderItem {
  id: string;
  addedByName: string;
  addedByRef: string;
  cartItem: GroupCartItem;
  quantity: number;
  lineTotal: number;
  isPaid: boolean;
}

export interface GroupOrderView {
  id: string;
  token: string;
  locationId: string;
  brandId: string | null;
  hostName: string | null;
  status: "OPEN" | "LOCKED" | "PLACED" | "EXPIRED" | "CANCELLED";
  fulfillmentType: string;
  paymentMode: "HOST_PAYS" | "SPLIT";
  orderId: string | null;
  expiresAt: string | null;
  /** True when the ref we asked with is the ref that opened the basket. The
   *  host's own ref is never sent back, so this is the only way to know. */
  isHost: boolean;
  items: GroupOrderItem[];
  subtotal: number;
  /** Per-person totals — drives the "who owes what" list. */
  people: Array<{ ref: string; name: string; total: number; count: number }>;
}

/**
 * A guest's identity is a name plus a browser-scoped ref — that ref is the
 * ONLY thing stopping one guest editing another's lines, so it must be stable
 * per browser and never reused across people.
 */
const REF_KEY = "orderhub.groupRef";
const NAME_KEY = "orderhub.groupName";

export function getGuestRef(): string {
  if (typeof window === "undefined") return "";
  let ref = window.localStorage.getItem(REF_KEY);
  if (!ref) {
    ref = crypto.randomUUID();
    try {
      window.localStorage.setItem(REF_KEY, ref);
    } catch {
      /* private window — the ref stays in memory for this page only */
    }
  }
  return ref;
}

/**
 * The name this browser joins group orders under. Remembered so someone who
 * joins a second office lunch doesn't retype it, and so a refresh mid-order
 * doesn't turn "Sarah" into a second anonymous person in the basket.
 */
export function getGuestName(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setGuestName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
  } catch {
    /* private window — non-fatal, they'll just be asked again */
  }
}

export const groupOrdersClient = {
  create: (body: {
    locationId: string;
    brandId?: string;
    hostName: string;
    hostRef: string;
    fulfillmentType?: "DELIVERY" | "PICKUP";
    paymentMode?: "HOST_PAYS" | "SPLIT";
  }) =>
    apiClient
      .post<GroupOrderView>("/v1/group-orders", body)
      .then((r) => r.data),

  /** `ref` is our own browser ref — it decides whether we're told we're the
   *  host. Sending it grants nothing on its own. */
  get: (token: string, ref?: string) =>
    apiClient
      .get<GroupOrderView>(`/v1/group-orders/${token}`, {
        params: ref ? { ref } : undefined,
      })
      .then((r) => r.data),

  addItem: (
    token: string,
    body: {
      addedByName: string;
      addedByRef: string;
      cartItem: GroupCartItem;
      quantity: number;
      lineTotal: number;
    },
  ) =>
    apiClient
      .post<GroupOrderView>(`/v1/group-orders/${token}/items`, body)
      .then((r) => r.data),

  removeItem: (token: string, itemId: string, ref: string) =>
    apiClient
      .delete<GroupOrderView>(`/v1/group-orders/${token}/items/${itemId}`, {
        params: { ref },
      })
      .then((r) => r.data),

  lock: (token: string, hostRef: string) =>
    apiClient
      .post<GroupOrderView>(`/v1/group-orders/${token}/lock`, { hostRef })
      .then((r) => r.data),

  unlock: (token: string, hostRef: string) =>
    apiClient
      .post<GroupOrderView>(`/v1/group-orders/${token}/unlock`, { hostRef })
      .then((r) => r.data),

  /** Returns the created Order. CARD orders carry `checkoutUrl` — the host
   *  finishes on Stripe's hosted page, same as an ordinary online order. */
  place: (
    token: string,
    body: {
      hostRef: string;
      customerInfo: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        /** Optional outside the UK — the Gulf has no everyday postcodes. */
        postcode?: string;
        /** The picked community. What prices the order where the shop
         *  charges by area rather than by postcode. */
        area?: string;
        latitude?: number;
        longitude?: number;
        country?: string;
      };
      deliveryFee?: number;
      specialInstructions?: string;
      paymentMethod?: string;
      paymentStatus?: string;
      idempotencyKey?: string;
    },
  ) =>
    apiClient
      .post<{ id: string; checkoutUrl?: string }>(
        `/v1/group-orders/${token}/place`,
        body,
      )
      .then((r) => r.data),

  cancel: (token: string, hostRef: string) =>
    apiClient
      .post(`/v1/group-orders/${token}/cancel`, { hostRef })
      .then((r) => r.data),

  /** The link a host shares. */
  shareUrl: (slug: string, token: string) =>
    `${window.location.origin}/order/${slug}/group/${token}`,
};
