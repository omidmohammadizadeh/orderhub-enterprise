import { apiClient } from "./client";

// Phase TB — Talabat (Delivery Hero POS Middleware) management.
//
// The model worth knowing: one OrderHub integration, many Talabat CHAINS
// (chain code, assigned by Talabat), each with VENDORS. A vendor is one brand
// at one location, and Talabat route its orders to us by a REMOTE ID we
// choose. Connecting = recording that remote ID plus the chain/vendor codes
// Talabat gave us.

export interface TalabatCatalogState {
  menuId: string;
  catalogImportId: string | null;
  status: string;
  message?: string | null;
  sentAt: string;
  finishedAt?: string | null;
  stats?: { categories: number; products: number; toppings: number; options: number; images: number; scheduleEntries: number };
  warnings?: string[];
}

export interface TalabatConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  remoteId: string | null;
  chainCode: string | null;
  platformVendorId: string | null;
  globalEntityId: string | null;
  platformKey: string | null;
  defaultPrepMinutes: number;
  defaultDeliveryMinutes: number;
  lastWebhookAt: string | null;
  lastError: string | null;
  catalog: TalabatCatalogState | null;
  availability: { timestamp: string; open: boolean; closures: Array<{ reason: string; start: string; end?: string | null; changeable: boolean }> } | null;
  configured: boolean;
  hubriseWarning?: boolean;
}

export interface TalabatProblem {
  level: "error" | "warning";
  message: string;
  itemId?: string;
}

export interface TalabatPreview {
  menu: { id: string; name: string };
  remoteId: string | null;
  chainCode: string | null;
  wouldPublish: boolean;
  problems: TalabatProblem[];
  stats: NonNullable<TalabatCatalogState["stats"]>;
  catalog: unknown;
}

export interface TalabatPromotionRow {
  name: string;
  orders: number;
  amount: number;
  platform: number;
  vendor: number;
  thirdParty: number;
  unattributed: number;
}

export interface TalabatPromotionsReport {
  from: string;
  to: string;
  orders: number;
  ordersWithDiscount: number;
  sales: number;
  discounts: Omit<TalabatPromotionRow, "name">;
  byPromotion: TalabatPromotionRow[];
  note: string;
}

export interface TalabatPluginCall {
  at: string;
  endpoint: string;
  remoteId: string | null;
  ref: string | null;
  jwt: string;
  httpStatus: number;
  outcome: string;
  preview: string;
}

export interface TalabatDiagnostics {
  environment: "staging" | "production";
  sandbox: boolean;
  sandboxWarning?: string;
  baseUrl: string | null;
  configured: boolean;
  missing: string[];
  usernameSet: boolean;
  passwordSet: boolean;
  pluginSecretSet: boolean;
  pluginBaseUrl: string;
  retryInSeconds: number;
  middlewareEverVerified: boolean;
  recentCalls: TalabatPluginCall[];
  login: string | { ok: true; tokenLength: number } | { ok: false; status?: number; talabatSaid?: string; error?: string };
}

const base = "/v1/integrations/talabat";

export const talabatClient = {
  diagnostics: () => apiClient.get<TalabatDiagnostics>(`${base}/diagnostics`).then((r) => r.data),
  retry: () => apiClient.post(`${base}/retry`).then((r) => r.data),
  pluginCalls: (limit = 25) =>
    apiClient.get<TalabatPluginCall[]>(`${base}/plugin-calls`, { params: { limit } }).then((r) => r.data),

  connections: (params: { brandId?: string; locationId?: string } = {}) =>
    apiClient.get<TalabatConnection[]>(`${base}/connections`, { params }).then((r) => r.data),
  connect: (body: {
    brandId: string;
    locationId: string;
    remoteId?: string;
    chainCode?: string;
    platformVendorId?: string;
    globalEntityId?: string;
    defaultPrepMinutes?: number;
    defaultDeliveryMinutes?: number;
  }) => apiClient.post<TalabatConnection>(`${base}/connections`, body).then((r) => r.data),
  disconnect: (id: string) => apiClient.post<TalabatConnection>(`${base}/connections/${id}/disconnect`).then((r) => r.data),
  activationSheet: () => apiClient.get<unknown>(`${base}/activation-sheet`).then((r) => r.data),

  preview: (id: string, menuId?: string) =>
    apiClient
      .get<TalabatPreview>(`${base}/connections/${id}/catalog/preview`, { params: menuId ? { menuId } : undefined })
      .then((r) => r.data),
  publish: (id: string, menuId?: string) =>
    apiClient.post(`${base}/connections/${id}/catalog/publish`, { menuId }).then((r) => r.data),
  catalogLogs: (id: string) => apiClient.get(`${base}/connections/${id}/catalog/logs`).then((r) => r.data),
  /** Publish-modal entry point, by menu. */
  publishMenu: (menuId: string, body: { locationId?: string; brandId?: string }) =>
    apiClient
      .post<
        | { ok: true; pending: true; catalogImportId: string | null; warnings: string[] }
        | { ok: false; errors: TalabatProblem[]; warnings: string[] }
      >(`${base}/menus/${menuId}/publish`, body)
      .then((r) => r.data),

  availability: (id: string) => apiClient.get(`${base}/connections/${id}/availability`).then((r) => r.data),
  setAvailability: (id: string, body: { open: boolean; minutes?: number; reason?: string }) =>
    apiClient.post(`${base}/connections/${id}/availability`, body).then((r) => r.data),

  reconcile: (id: string, body: { hours?: number; importMissing?: boolean } = {}) =>
    apiClient.post(`${base}/connections/${id}/reconcile`, body).then((r) => r.data),
  promotions: (params: { from?: string; to?: string; locationId?: string; brandId?: string }) =>
    apiClient.get<TalabatPromotionsReport>(`${base}/promotions`, { params }).then((r) => r.data),

  prepTime: (orderId: string, body: { minutes?: number; expectedPickupAt?: string }) =>
    apiClient.post<{ expectedPickupAt: string }>(`${base}/orders/${orderId}/prep-time`, body).then((r) => r.data),
  modify: (orderId: string, changes: Array<{ productId: string; remove?: boolean; quantity?: number }>) =>
    apiClient.post(`${base}/orders/${orderId}/modify`, { changes }).then((r) => r.data),
  resync: (orderId: string) => apiClient.post(`${base}/orders/${orderId}/resync`).then((r) => r.data),

  sandbox: {
    status: () => apiClient.get(`/v1/talabat-sandbox/status`).then((r) => r.data as any),
    calls: (limit = 30) => apiClient.get(`/v1/talabat-sandbox/calls`, { params: { limit } }).then((r) => r.data as any[]),
    reset: () => apiClient.post(`/v1/talabat-sandbox/reset`).then((r) => r.data),
    simulateOrder: (
      connectionId: string,
      body: { kind?: "OWN_DELIVERY" | "VENDOR_DELIVERY" | "PICKUP"; test?: boolean; withDiscount?: boolean; itemCount?: number },
    ) => apiClient.post(`/v1/talabat-sandbox/connections/${connectionId}/simulate-order`, body).then((r) => r.data as any),
    notify: (token: string, status: string) =>
      apiClient.post(`/v1/talabat-sandbox/orders/${token}/notify`, { status }).then((r) => r.data),
    notifyAvailability: (connectionId: string, body: { closed: boolean; reason?: string; minutes?: number; changeable?: boolean }) =>
      apiClient.post(`/v1/talabat-sandbox/connections/${connectionId}/notify-availability`, body).then((r) => r.data),
    requestMenu: (connectionId: string) =>
      apiClient.post(`/v1/talabat-sandbox/connections/${connectionId}/request-menu`).then((r) => r.data),
  },
};
