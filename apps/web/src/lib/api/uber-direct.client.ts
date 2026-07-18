// Uber Direct last-mile courier — per-location config + dispatch. Each location
// plugs in its own Uber Direct account (Customer ID / Client ID / Secret /
// signing key); OrderHub debits a flat wallet fee per dispatch (admin bypasses).

import { apiClient } from "./client";

export interface UberDirectConfig {
  configured: boolean;
  active: boolean;
  environment: string; // sandbox | production
  webhookUrl: string;
  customerIdMasked: string | null;
  clientIdMasked: string | null;
}

export interface UberDirectDispatchResult {
  ok: boolean;
  jobId: string | null;
  status: string;
  trackingUrl: string | null;
  feeChargedMinor: number;
  adminBypass: boolean;
}

export const uberDirectClient = {
  getConfig: (locationId: string) =>
    apiClient
      .get<UberDirectConfig>(`/v1/uber-direct/locations/${locationId}/config`)
      .then((r) => r.data),

  saveConfig: (
    locationId: string,
    body: {
      customerId: string;
      clientId: string;
      clientSecret: string;
      signingKey?: string;
      environment: string;
    },
  ) =>
    apiClient
      .put(`/v1/uber-direct/locations/${locationId}/config`, body)
      .then((r) => r.data),

  toggle: (locationId: string, active: boolean) =>
    apiClient
      .post(`/v1/uber-direct/locations/${locationId}/toggle`, { active })
      .then((r) => r.data),

  quote: (orderId: string) =>
    apiClient
      .post(`/v1/uber-direct/orders/${orderId}/quote`, {})
      .then((r) => r.data),

  dispatch: (orderId: string) =>
    apiClient
      .post<UberDirectDispatchResult>(
        `/v1/uber-direct/orders/${orderId}/dispatch`,
        {},
      )
      .then((r) => r.data),

  cancel: (orderId: string) =>
    apiClient
      .post(`/v1/uber-direct/orders/${orderId}/cancel`, {})
      .then((r) => r.data),
};
