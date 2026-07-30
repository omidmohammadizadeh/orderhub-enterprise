import { apiClient } from "./client";

// Self-service kiosk screens.
//
// Staff CRUD goes through apiClient (JWT). The device surface uses bare
// fetch on purpose — a kiosk has no login, and apiClient's 401 interceptor
// would try a token refresh and bounce the screen to /login mid-service.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export interface KioskDevice {
  id: string;
  tenantId: string;
  locationId: string;
  brandId: string | null;
  name: string;
  publicToken: string;
  isActive: boolean;
  config: {
    allowCardPayment?: boolean;
    allowPayAtCounter?: boolean;
    categoryIds?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface KioskResolved {
  /** The location's live POS menu, resolved server-side. */
  menu: any | null;
  kioskId: string;
  kioskName: string;
  locationId: string;
  locationName: string | null;
  brandId: string | null;
  brandName: string | null;
  brandSlug: string | null;
  logoUrl: string | null;
  allowCardPayment: boolean;
  allowPayAtCounter: boolean;
  categoryIds: string[];
}

export interface KioskOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers?: { name: string; price: number; quantity?: number }[];
  notes?: string | null;
  menuItemId?: string | null;
}

export interface KioskOrderResult {
  orderId: string;
  displayId: string | null;
  total: number;
  payment: "CARD" | "PAY_AT_COUNTER";
}

/** Carries the HTTP status so the screen can tell "not set up" from "offline". */
export class KioskError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = "Something went wrong";
  try {
    const body = await res.json();
    message = body?.message ?? message;
  } catch {
    /* non-JSON error page */
  }
  throw new KioskError(message, res.status);
}

export const kioskClient = {
  // ── Staff ─────────────────────────────────────────────────────────
  list: (locationId: string) =>
    apiClient
      .get<KioskDevice[]>(`/v1/kiosk`, { params: { locationId } })
      .then((r) => r.data),

  create: (input: {
    locationId: string;
    name: string;
    config?: KioskDevice["config"];
  }) => apiClient.post<KioskDevice>(`/v1/kiosk`, input).then((r) => r.data),

  update: (id: string, input: Partial<KioskDevice>) =>
    apiClient.patch<KioskDevice>(`/v1/kiosk/${id}`, input).then((r) => r.data),

  rotateToken: (id: string) =>
    apiClient
      .post<KioskDevice>(`/v1/kiosk/${id}/rotate-token`, {})
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/v1/kiosk/${id}`).then((r) => r.data),

  // ── Device (no auth) ──────────────────────────────────────────────
  resolve: async (token: string) => {
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/v1/kiosk/public/${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
    } catch {
      throw new KioskError("No connection", 0);
    }
    return unwrap<KioskResolved>(res);
  },

  placeOrder: async (
    token: string,
    body: {
      items: KioskOrderItem[];
      payment: "CARD" | "PAY_AT_COUNTER";
      customerName?: string;
      notes?: string | null;
      requestId?: string;
    },
  ) => {
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/v1/kiosk/public/${encodeURIComponent(token)}/order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // The order may or may not have landed — the copy must not promise
      // either way. requestId makes a retry safe.
      throw new KioskError("We couldn't reach the kitchen just now.", 0);
    }
    return unwrap<KioskOrderResult>(res);
  },
};
