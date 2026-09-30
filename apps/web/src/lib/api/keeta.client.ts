import { apiClient } from "./client";

// Phase KT — Keeta (Meituan) per-brand connect + store control.
//
// The shape worth knowing: Keeta authorize by BRAND, not by store. The
// merchant approves OrderHub once on Keeta's own site, and one authorization
// then covers every store they ticked. Connecting a location is picking which
// of those stores it is.

export interface KeetaShop {
  id: string;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface KeetaAuthorization {
  id: string;
  keetaBrandId: string | null;
  brandName: string | null;
  status: "active" | "revoked" | "refresh_failed" | string;
  expiresAt: string;
  lastRefreshAt: string | null;
  lastError: string | null;
  shops: KeetaShop[];
}

export interface KeetaMenuPublishState {
  menuId: string | null;
  status: "PROCESSING" | "SUCCESS" | "PARTIAL" | "FAILED" | "SEND_FAILED" | string | null;
  taskId: string | null;
  sentAt: string | null;
  finishedAt: string | null;
  errors: Array<{ name?: string; code?: string; message?: string }>;
  pictureErrors: Array<{ url?: string; message?: string }>;
  warnings: string[];
  stats: { categories: number; spus: number; skus: number; groups: number; options: number } | null;
}

export interface KeetaConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  shopId: string | null;
  shopName: string | null;
  keetaBrandId: string | null;
  authorizationId: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  storeStatus: { status: number | null; at: string } | null;
  menuPublish: KeetaMenuPublishState | null;
}

export interface KeetaHealth extends KeetaConnection {
  configured: boolean;
  environment: "test" | "production";
  authorization: { status: string; expiresAt: string; brandName: string | null; lastError: string | null } | null;
  lastOrder: { id: string; displayId: string | null; createdAt: string; status: string } | null;
}

export interface KeetaMenuProblem {
  entity: string;
  code: string;
  name?: string;
  message: string;
}

const base = "/v1/integrations/keeta";

export const keetaClient = {
  /** Where to send the merchant to approve OrderHub on Keeta. */
  authorize: (data: { brandId?: string; locationId?: string }) =>
    apiClient.post<{ url: string; expiresInMinutes: number }>(`${base}/authorize`, data).then((r) => r.data),

  authorizations: () => apiClient.get<KeetaAuthorization[]>(`${base}/authorizations`).then((r) => r.data),

  refreshShops: (authorizationId: string) =>
    apiClient
      .post<{ shops: KeetaShop[] }>(`${base}/authorizations/${authorizationId}/refresh-shops`, {})
      .then((r) => r.data),

  connect: (data: { brandId: string; locationId: string; authorizationId: string; shopId: string }) =>
    apiClient.post<KeetaConnection>(`${base}/connect`, data).then((r) => r.data),

  health: (connectionId: string) =>
    apiClient.get<KeetaHealth>(`${base}/connections/${connectionId}/health`).then((r) => r.data),

  disconnect: (connectionId: string) =>
    apiClient.post(`${base}/connections/${connectionId}/disconnect`, {}).then((r) => r.data),

  pause: (connectionId: string) =>
    apiClient.post<{ ok: boolean; open: boolean }>(`${base}/connections/${connectionId}/pause`, {}).then((r) => r.data),

  resume: (connectionId: string) =>
    apiClient.post<{ ok: boolean; open: boolean }>(`${base}/connections/${connectionId}/resume`, {}).then((r) => r.data),

  publishHours: (connectionId: string) =>
    apiClient
      .post<{ ok: boolean; configured: boolean }>(`${base}/connections/${connectionId}/publish-hours`, {})
      .then((r) => r.data),

  publishMenu: (menuId: string, body?: { locationId?: string }) =>
    apiClient
      .post<{
        ok: boolean;
        pending?: boolean;
        taskId?: string | null;
        shopId?: string;
        stats?: KeetaMenuPublishState["stats"];
        warnings?: KeetaMenuProblem[];
        errors?: KeetaMenuProblem[];
      }>(`${base}/menus/${menuId}/publish`, body ?? {})
      .then((r) => r.data),

  agreeRefund: (orderId: string) =>
    apiClient.post(`${base}/orders/${orderId}/refund/agree`, {}).then((r) => r.data),

  rejectRefund: (orderId: string, body: { rejectCode: 100000 | 100001 | 100002; rejectReason?: string }) =>
    apiClient.post(`${base}/orders/${orderId}/refund/reject`, body).then((r) => r.data),
};
