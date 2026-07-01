import { apiClient } from "./client";

// Phase BA-2 — Deliveroo per-brand connect + store control.
export interface DeliverooConnection {
  id: string;
  status: string;
  storeId: string;
  deliverooBrandId: string;
}

export const deliverooClient = {
  connect: (data: {
    brandId: string;
    locationId: string;
    storeId: string;
    deliverooBrandId?: string;
  }) =>
    apiClient
      .post<DeliverooConnection>("/v1/integrations/deliveroo/connect", data)
      .then((r) => r.data),

  fetchBrandId: (storeId: string) =>
    apiClient
      .post<{ deliverooBrandId: string }>(
        "/v1/integrations/deliveroo/fetch-brand-id",
        { storeId },
      )
      .then((r) => r.data),

  disconnect: (connectionId: string) =>
    apiClient
      .post(`/v1/integrations/deliveroo/${connectionId}/disconnect`, {})
      .then((r) => r.data),

  status: (connectionId: string) =>
    apiClient
      .get<{ status: string }>(
        `/v1/integrations/deliveroo/${connectionId}/status`,
      )
      .then((r) => r.data),

  pause: (connectionId: string) =>
    apiClient
      .post<{ status: string }>(
        `/v1/integrations/deliveroo/${connectionId}/pause`,
        {},
      )
      .then((r) => r.data),

  resume: (connectionId: string) =>
    apiClient
      .post<{ status: string }>(
        `/v1/integrations/deliveroo/${connectionId}/resume`,
        {},
      )
      .then((r) => r.data),

  publishHours: (connectionId: string) =>
    apiClient
      .post(`/v1/integrations/deliveroo/${connectionId}/publish-hours`, {})
      .then((r) => r.data),
};
