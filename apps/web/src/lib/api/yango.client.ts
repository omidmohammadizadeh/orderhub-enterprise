// Yango Delivery — courier dispatch for UAE shops, per location. Same money
// model as Stuart / Uber Direct / JET Go: the shop's own Yango business account
// pays for the courier, OrderHub debits a flat wallet fee per dispatch (admin
// bypasses).
//
// What's different:
//   • NO sandbox. A location starts in ESTIMATE-ONLY mode — quotes are real,
//     the dispatch button isn't — and going live needs an explicit confirmation.
//   • Yango takes coordinates, so each shop stores a pickup point.
//   • Cancelling can COST money once the courier reaches the shop; the first
//     cancel call returns the fee instead of charging it.

import { apiClient } from "./client";

export type YangoMode = "estimate_only" | "live";

export interface YangoConfig {
  configured: boolean;
  active: boolean;
  /** Yango is offered in the UAE only. False = hide it for this shop. */
  countrySupported: boolean;
  mode: YangoMode;
  taxiClass: "courier" | "express";
  contactEmail: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  tokenMasked: string | null;
  webhookUrl: string | null;
  /** Active + token + pickup point: quotes work (both modes). */
  canQuote: boolean;
  /** canQuote AND live mode: dispatch books real couriers. */
  readyToDispatch: boolean;
}

export interface YangoQuote {
  currency: string;
  amount: number | null;
  etaMinutes: number | null;
  distanceMeters: number | null;
  mode: YangoMode;
  canDispatch: boolean;
  dispatchFeeMinor: number;
  warnings: string[];
}

export interface YangoDispatchResult {
  ok: boolean;
  jobId: string;
  status: string;
  accepted: boolean;
  /** Yango is still pricing; the courier is booked within seconds, or refused
   *  (fee refunded) if the price jumped. */
  pending: boolean;
  quotedPrice: number | null;
  currency: string;
  feeChargedMinor: number;
  adminBypass: boolean;
  warnings: string[];
}

export interface YangoCancelResult {
  ok: boolean;
  needsConfirmation?: boolean;
  cancelState?: string;
  fee?: number | null;
  currency?: string | null;
  message: string;
}

export interface YangoSaveBody {
  token?: string;
  mode?: YangoMode;
  acknowledgeLiveCouriers?: boolean;
  taxiClass?: string;
  contactEmail?: string;
  pickupLat?: number;
  pickupLng?: number;
}

export const yangoClient = {
  getConfig: (locationId: string) =>
    apiClient.get<YangoConfig>(`/v1/yango/locations/${locationId}/config`).then((r) => r.data),

  saveConfig: (locationId: string, body: YangoSaveBody) =>
    apiClient
      .put<{ ok: boolean; mode: YangoMode; geocodedPickup: boolean; pickupMissing: boolean }>(
        `/v1/yango/locations/${locationId}/config`,
        body,
      )
      .then((r) => r.data),

  verify: (locationId: string) =>
    apiClient
      .post<{ ok: boolean; message: string; classes?: string[]; classAvailable?: boolean }>(
        `/v1/yango/locations/${locationId}/verify`,
        {},
      )
      .then((r) => r.data),

  toggle: (locationId: string, active: boolean) =>
    apiClient.post(`/v1/yango/locations/${locationId}/toggle`, { active }).then((r) => r.data),

  quote: (orderId: string) =>
    apiClient.post<YangoQuote>(`/v1/yango/orders/${orderId}/quote`, {}).then((r) => r.data),

  dispatch: (orderId: string) =>
    apiClient.post<YangoDispatchResult>(`/v1/yango/orders/${orderId}/dispatch`, {}).then((r) => r.data),

  cancel: (orderId: string, confirmPaid = false) =>
    apiClient
      .post<YangoCancelResult>(`/v1/yango/orders/${orderId}/cancel`, { confirmPaid })
      .then((r) => r.data),

  refreshStatus: (orderId: string) =>
    apiClient
      .post<{ ok: boolean; status: string | null }>(`/v1/yango/orders/${orderId}/refresh-status`, {})
      .then((r) => r.data),
};
