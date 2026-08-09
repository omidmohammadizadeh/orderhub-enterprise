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

  // `amount` makes this a PART payment for a split bill — the reader
  // takes just that much and the order stays open until the parts cover
  // the total. Omit it to charge the whole order, as before.
  charge: (orderId: string, readerId: string, amount?: number) =>
    apiClient
      .post<{
        paymentIntentId: string;
        readerId: string;
        status: string;
        simulated: boolean;
        amount: number;
      }>(`/v1/payments/terminal/charge`, {
        orderId,
        readerId,
        ...(amount !== undefined ? { amount } : {}),
      })
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
  // native SDK fetches its own connection token. `orderId` lets the backend
  // resolve the connected account WITH that order's brandId, so this call
  // and the later chargeMobile(orderId) land on the SAME account — required
  // whenever a brand has its own escape-hatch Stripe account.
  // `stripeAccountId` is the connected account this session will be opened
  // against. Pass it into OrderHubTerminal.connect so the native side can
  // tell an already-paired session apart from one opened for a DIFFERENT
  // account — reusing the wrong one makes the reader fail to see the
  // PaymentIntent ("No such payment_intent").
  connectionToken: (locationId?: string, simulated?: boolean, orderId?: string) =>
    apiClient
      .post<{
        secret: string;
        stripeLocationId: string | null;
        simulated: boolean;
        stripeAccountId: string | null;
      }>(`/v1/payments/terminal/connection-token`, { locationId, simulated, orderId })
      .then((r) => r.data),

  // Prepares an on-device card-present charge; returns the client secret the
  // native SDK collects + confirms on the reader. `simulated` runs it in test
  // mode (no hardware, no real money) for verifying the flow.
  chargeMobile: (orderId: string, simulated?: boolean) =>
    apiClient
      .post<{
        paymentIntentId: string;
        clientSecret: string;
        amount: number;
        currency: string;
        simulated: boolean;
      }>(`/v1/payments/terminal/charge/mobile`, { orderId, simulated })
      .then((r) => r.data),
};
