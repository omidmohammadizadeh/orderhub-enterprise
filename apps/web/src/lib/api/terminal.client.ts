import { apiClient } from "./client";

// Stripe Terminal (S700 / WisePOS E) — server-driven card-present payments.

export interface TerminalReader {
  id: string;
  label: string;
  deviceType: string | null;
  simulated: boolean;
  status?: string;
  addedAt?: string;
}

export const terminalClient = {
  listReaders: (locationId: string) =>
    apiClient
      .get<{ readers: TerminalReader[]; stripeLocationId: string | null; testMode: boolean }>(
        `/v1/payments/terminal/locations/${locationId}/readers`,
      )
      .then((r) => r.data),

  registerReader: (locationId: string, registrationCode: string, label?: string) =>
    apiClient
      .post<TerminalReader>(`/v1/payments/terminal/locations/${locationId}/readers`, {
        registrationCode,
        label,
      })
      .then((r) => r.data),

  registerSimulated: (locationId: string) =>
    apiClient
      .post<TerminalReader>(
        `/v1/payments/terminal/locations/${locationId}/readers/simulated`,
        {},
      )
      .then((r) => r.data),

  removeReader: (locationId: string, readerId: string) =>
    apiClient
      .delete(`/v1/payments/terminal/locations/${locationId}/readers/${readerId}`)
      .then((r) => r.data),

  charge: (orderId: string, readerId: string) =>
    apiClient
      .post<{
        paymentIntentId: string;
        readerId: string;
        status: string;
        simulated: boolean;
        amount: number;
      }>(`/v1/payments/terminal/charge`, { orderId, readerId })
      .then((r) => r.data),

  simulatePresent: (readerId: string) =>
    apiClient
      .post(`/v1/payments/terminal/simulate-present`, { readerId })
      .then((r) => r.data),

  status: (paymentIntentId: string) =>
    apiClient
      .get<{ paymentIntentId: string; status: string; paid: boolean }>(
        `/v1/payments/terminal/charge/status`,
        { params: { paymentIntentId } },
      )
      .then((r) => r.data),

  // ── SDK-driven mobile reader (BBPOS WisePad 3, in the native app) ─────────

  // Ensures the Stripe Terminal location exists and returns its id (needed to
  // connect the Bluetooth reader). The `secret` is unused by the web — the
  // native SDK fetches its own connection token.
  connectionToken: (locationId?: string) =>
    apiClient
      .post<{ secret: string; stripeLocationId: string | null }>(
        `/v1/payments/terminal/connection-token`,
        { locationId },
      )
      .then((r) => r.data),

  // Prepares an on-device card-present charge; returns the client secret the
  // native SDK collects + confirms on the reader.
  chargeMobile: (orderId: string) =>
    apiClient
      .post<{
        paymentIntentId: string;
        clientSecret: string;
        amount: number;
        currency: string;
      }>(`/v1/payments/terminal/charge/mobile`, { orderId })
      .then((r) => r.data),
};
