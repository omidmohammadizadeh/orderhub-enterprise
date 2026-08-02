import { apiClient } from "./client";

// Group ordering — a shared basket several people add to before it becomes
// one order. Every endpoint is public: guests join by link with no account,
// so the share token is the basket's credential.

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

export const groupOrdersClient = {
  create: (body: {
    tenantId: string;
    locationId: string;
    brandId?: string;
    hostName: string;
    fulfillmentType?: "DELIVERY" | "PICKUP";
    paymentMode?: "HOST_PAYS" | "SPLIT";
  }) =>
    apiClient
      .post<GroupOrderView>("/v1/group-orders", body)
      .then((r) => r.data),

  get: (token: string) =>
    apiClient
      .get<GroupOrderView>(`/v1/group-orders/${token}`)
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

  lock: (token: string) =>
    apiClient
      .post<GroupOrderView>(`/v1/group-orders/${token}/lock`)
      .then((r) => r.data),

  unlock: (token: string) =>
    apiClient
      .post<GroupOrderView>(`/v1/group-orders/${token}/unlock`)
      .then((r) => r.data),

  place: (
    token: string,
    body: {
      customerInfo: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        postcode: string;
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
      .post(`/v1/group-orders/${token}/place`, body)
      .then((r) => r.data),

  cancel: (token: string) =>
    apiClient.post(`/v1/group-orders/${token}/cancel`).then((r) => r.data),

  /** The link a host shares. */
  shareUrl: (slug: string, token: string) =>
    `${window.location.origin}/order/${slug}/group/${token}`,
};
