// JET Go — Just Eat Takeaway's last-mile courier network (Delivery-as-a-Service),
// per location. Same money model as Stuart and Uber Direct: the shop plugs in its
// own JET Go credentials so JET bills them for the courier, and OrderHub debits a
// flat wallet fee per dispatch (admin bypasses).
//
// Two things the other networks don't need:
//   • a COLLECT POINT — JET dispatches from a point it has already onboarded, not
//     from a pasted address, so one has to be chosen before dispatch works.
//   • a webhook REGISTERED with JET via the API rather than pasted into a portal.

import { apiClient } from "./client";

export interface JetGoConfig {
  configured: boolean;
  active: boolean;
  market: string; // UK | CA | AU | EU
  environment: string; // sandbox | production
  webhookUrl: string | null;
  webhookUsername: string | null;
  clientIdMasked: string | null;
  collectPointId: string | null;
  collectPointName: string | null;
  /** Credentials AND a collect point AND active. Dispatch needs all three. */
  readyToDispatch: boolean;
}

export interface JetGoCollectPoint {
  id: string;
  name: string;
  address: string;
  countryCode: string | null;
}

export interface JetGoQuote {
  currency: string;
  amount: number | null;
  quoteId: string | null;
  feeRule: string | null;
  collectBy: string | null;
  deliverBy: string | null;
  dispatchFeeMinor: number;
  /** Things the operator should see before committing — a cash order no courier
   *  will collect, or a scheduled slot JET will treat as ASAP. */
  warnings: string[];
}

export interface JetGoDispatchResult {
  ok: boolean;
  jobId: string | null;
  status: string;
  trackingUrl: string | null;
  courierFeeMinor: number | null;
  collectBy: string | null;
  deliverBy: string | null;
  feeChargedMinor: number;
  adminBypass: boolean;
  warnings: string[];
}

export interface JetGoWebhookStatus {
  ok: boolean;
  registered: boolean;
  endpoint?: string | null;
  /** False means JET is posting somewhere else — courier updates never arrive,
   *  and nothing else on the screen would look wrong. */
  matchesOurs?: boolean;
  expected?: string | null;
  message?: string;
}

export const jetGoClient = {
  getConfig: (locationId: string) =>
    apiClient
      .get<JetGoConfig>(`/v1/jet-go/locations/${locationId}/config`)
      .then((r) => r.data),

  saveConfig: (
    locationId: string,
    body: { clientId: string; clientSecret: string; market: string; environment: string },
  ) => apiClient.put(`/v1/jet-go/locations/${locationId}/config`, body).then((r) => r.data),

  collectPoints: (locationId: string) =>
    apiClient
      .get<{ ok: boolean; collectPoints: JetGoCollectPoint[]; message?: string }>(
        `/v1/jet-go/locations/${locationId}/collect-points`,
      )
      .then((r) => r.data),

  setCollectPoint: (locationId: string, collectPointId: string, collectPointName?: string) =>
    apiClient
      .put(`/v1/jet-go/locations/${locationId}/collect-point`, {
        collectPointId,
        collectPointName,
      })
      .then((r) => r.data),

  registerWebhook: (locationId: string) =>
    apiClient
      .post<{ ok: boolean; endpoint?: string; message?: string }>(
        `/v1/jet-go/locations/${locationId}/register-webhook`,
        {},
      )
      .then((r) => r.data),

  webhookStatus: (locationId: string) =>
    apiClient
      .get<JetGoWebhookStatus>(`/v1/jet-go/locations/${locationId}/webhook-status`)
      .then((r) => r.data),

  toggle: (locationId: string, active: boolean) =>
    apiClient
      .post(`/v1/jet-go/locations/${locationId}/toggle`, { active })
      .then((r) => r.data),

  quote: (orderId: string) =>
    apiClient.post<JetGoQuote>(`/v1/jet-go/orders/${orderId}/quote`, {}).then((r) => r.data),

  dispatch: (orderId: string) =>
    apiClient
      .post<JetGoDispatchResult>(`/v1/jet-go/orders/${orderId}/dispatch`, {})
      .then((r) => r.data),

  /** Asks JET to cancel. Confirmed by webhook, so the order stays with the
   *  courier until JET says otherwise. */
  cancel: (orderId: string) =>
    apiClient
      .post<{ ok: boolean; pending: boolean; message: string }>(
        `/v1/jet-go/orders/${orderId}/cancel`,
        {},
      )
      .then((r) => r.data),

  refreshStatus: (orderId: string) =>
    apiClient
      .post<{ ok: boolean; status: string | null }>(
        `/v1/jet-go/orders/${orderId}/refresh-status`,
        {},
      )
      .then((r) => r.data),

  /** Sandbox only — walks a test delivery through the real webhook sequence. */
  simulate: (orderId: string, body: { deliveryStep?: string; stepWaitDuration?: number } = {}) =>
    apiClient
      .post<{ ok: boolean; requestId: string; message: string | null }>(
        `/v1/jet-go/orders/${orderId}/simulate`,
        body,
      )
      .then((r) => r.data),
};
