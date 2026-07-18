// Stuart last-mile courier — per-location config + dispatch. Each location plugs
// in its own Stuart client ID/secret; OrderHub debits a flat wallet fee (default
// 50p) per dispatch (PLATFORM_ADMIN bypasses).

import { apiClient } from "./client";

export interface StuartConfig {
  configured: boolean;
  active: boolean;
  environment: string; // sandbox | production
  webhookUrl: string;
  webhookAuthHeader: string;
  webhookAuthKey: string | null;
  clientIdMasked: string | null;
}

export interface StuartDispatchResult {
  ok: boolean;
  jobId: string | number | null;
  status: string;
  trackingUrl: string | null;
  feeChargedMinor: number;
  adminBypass: boolean;
}

export const stuartClient = {
  getConfig: (locationId: string) =>
    apiClient
      .get<StuartConfig>(`/v1/stuart/locations/${locationId}/config`)
      .then((r) => r.data),

  saveConfig: (
    locationId: string,
    body: { clientId: string; clientSecret: string; environment: string },
  ) =>
    apiClient
      .put(`/v1/stuart/locations/${locationId}/config`, body)
      .then((r) => r.data),

  toggle: (locationId: string, active: boolean) =>
    apiClient
      .post(`/v1/stuart/locations/${locationId}/toggle`, { active })
      .then((r) => r.data),

  quote: (orderId: string) =>
    apiClient.post(`/v1/stuart/orders/${orderId}/quote`, {}).then((r) => r.data),

  dispatch: (orderId: string) =>
    apiClient
      .post<StuartDispatchResult>(`/v1/stuart/orders/${orderId}/dispatch`, {})
      .then((r) => r.data),

  cancel: (orderId: string) =>
    apiClient
      .post(`/v1/stuart/orders/${orderId}/cancel`, {})
      .then((r) => r.data),
};
