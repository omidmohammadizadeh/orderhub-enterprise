import { apiClient } from "./client";

// Phase GL — Glovo (restaurant Partners API) per-brand connect + store control.
//
// Mirrors justeat.client. The shape worth knowing: WE choose the store ID and
// give it to Glovo (their docs: "This Store ID is the one provided by you"),
// so connect takes it optionally and the server derives a stable default.

export interface GlovoMenuPublishState {
  menuId: string | null;
  status: string | null;
  details: string[];
  sentAt: string | null;
  fetchedAt: string | null;
  transactionId: string | null;
  uploadsLast24h: number;
}

export interface GlovoConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  storeId: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  menuPublish: GlovoMenuPublishState | null;
}

export interface GlovoHealth extends GlovoConnection {
  tokenConfigured: boolean;
  webhookAuthEnforced: boolean;
  environment: "stage" | "production";
  lastOrder: { id: string; displayId: string | null; createdAt: string; status: string } | null;
}

export const glovoClient = {
  connect: (data: { brandId: string; locationId: string; storeId?: string }) =>
    apiClient.post<GlovoConnection>("/v1/integrations/glovo/connect", data).then((r) => r.data),

  health: (connectionId: string) =>
    apiClient.get<GlovoHealth>(`/v1/integrations/glovo/${connectionId}/health`).then((r) => r.data),

  disconnect: (connectionId: string) =>
    apiClient.post(`/v1/integrations/glovo/${connectionId}/disconnect`, {}).then((r) => r.data),

  /** `until` is an ISO instant. Glovo needs an end time; without one the server caps it. */
  pause: (connectionId: string, until?: string) =>
    apiClient
      .post<{ ok: boolean; open: boolean; until: string | null; openEnded: boolean }>(
        `/v1/integrations/glovo/${connectionId}/pause`,
        until ? { until } : {},
      )
      .then((r) => r.data),

  resume: (connectionId: string) =>
    apiClient
      .post<{ ok: boolean; open: boolean }>(`/v1/integrations/glovo/${connectionId}/resume`, {})
      .then((r) => r.data),

  closing: (connectionId: string) =>
    apiClient
      .get<{ closed: boolean; until: string | null }>(`/v1/integrations/glovo/${connectionId}/closing`)
      .then((r) => r.data),

  menuStatus: (connectionId: string) =>
    apiClient
      .get<{ status: string | null; details: string[] }>(`/v1/integrations/glovo/${connectionId}/menu-status`)
      .then((r) => r.data),

  publishMenu: (menuId: string, body?: { locationId?: string }) =>
    apiClient
      .post<{
        ok: boolean;
        pending: boolean;
        storeId: string;
        transactionId: string | null;
        uploadsLeftToday: number;
        products: number;
        warnings?: string[];
      }>(`/v1/integrations/glovo/menus/${menuId}/publish`, body ?? {})
      .then((r) => r.data),
};
