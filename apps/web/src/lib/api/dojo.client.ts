import { apiClient } from "./client";

// Dojo card machines — the second counter-reader provider beside Stripe.
// Each location connects its OWN Dojo account with its secret API key; the
// money goes straight to the shop's Dojo account.

export interface DojoTerminal {
  id: string;
  tid: string | null;
  label: string;
  /** Available | Offline | InUse | Unknown */
  status: string;
}

export type DojoStatus =
  | { connected: false; partnerIdsConfigured: boolean }
  | {
      connected: true;
      environment: "sandbox" | "production";
      keyHint: string;
      connectedAt: string;
      terminals: DojoTerminal[];
      terminalsError: string | null;
      webhook: boolean;
      partnerIdsConfigured: boolean;
      payAtTable: { enabled: boolean; registeredAt: string | null };
    };

export interface DojoChargeStatus {
  paymentIntentId: string;
  status: string;
  paid: boolean;
  failed: boolean;
  needsSignature: boolean;
  /** Expired session: Dojo never reported an outcome — check the machine. */
  unconfirmed?: boolean;
  /** What the machine is showing: PresentCard, EnterPin, InsertCard… */
  prompt?: string | null;
  message?: string;
}

const base = "/v1/payments/dojo";

export const dojoClient = {
  status: (locationId: string) =>
    apiClient.get<DojoStatus>(`${base}/locations/${locationId}`).then((r) => r.data),

  connect: (locationId: string, apiKey: string) =>
    apiClient.post<DojoStatus>(`${base}/locations/${locationId}/connect`, { apiKey }).then((r) => r.data),

  disconnect: (locationId: string) =>
    apiClient.delete(`${base}/locations/${locationId}`).then((r) => r.data),

  renameTerminal: (locationId: string, terminalId: string, label: string) =>
    apiClient
      .patch(`${base}/locations/${locationId}/terminals/${terminalId}`, { label })
      .then((r) => r.data),

  enablePayAtTable: (locationId: string) =>
    apiClient.post<DojoStatus>(`${base}/locations/${locationId}/pay-at-table`, {}).then((r) => r.data),

  disablePayAtTable: (locationId: string) =>
    apiClient.delete<DojoStatus>(`${base}/locations/${locationId}/pay-at-table`).then((r) => r.data),

  // `amount` = one share of a split bill; omit to charge the whole order.
  charge: (orderId: string, terminalId: string, amount?: number) =>
    apiClient
      .post<{ paymentIntentId: string; terminalSessionId: string; status: string; amount: number; sandbox: boolean }>(
        `${base}/charge`,
        { orderId, terminalId, ...(amount !== undefined ? { amount } : {}) },
      )
      .then((r) => r.data),

  chargeStatus: (paymentIntentId: string) =>
    apiClient
      .get<DojoChargeStatus>(`${base}/charge/status`, { params: { paymentIntentId } })
      .then((r) => r.data),

  cancel: (paymentIntentId: string) =>
    apiClient.post(`${base}/charge/cancel`, { paymentIntentId }).then((r) => r.data),

  // Full refund when `amount` is omitted.
  refund: (paymentIntentId: string, amount?: number, reason?: string) =>
    apiClient
      .post<{ refundId: string | null; amount: number; full: boolean; paymentIntentStatus: string | null; leftToRefund: number }>(
        `${base}/refund`,
        { paymentIntentId, ...(amount !== undefined ? { amount } : {}), ...(reason ? { reason } : {}) },
      )
      .then((r) => r.data),

  signature: (paymentIntentId: string, accepted: boolean) =>
    apiClient.post(`${base}/charge/signature`, { paymentIntentId, accepted }).then((r) => r.data),
};
