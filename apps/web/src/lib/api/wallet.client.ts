// Wallet — prepaid balance clients top up to send payment links & marketing
// texts. Balance is billed per Twilio segment. All amounts are MINOR units
// (pennies) end-to-end to avoid float drift.

import { apiClient } from "./client";

export interface WalletSummary {
  balanceMinor: number;
  currency: string;
  pricePerSegmentMinor: number;
  /** What an answered AI phone call costs this shop, in pence. */
  voicePricePerCallMinor: number;
  /** How many more calls the balance answers. null when calls are free. */
  callsRemaining: number | null;
  lowBalanceThresholdMinor: number;
  lowBalance: boolean;
  smsConfigured: boolean;
  autoTopup: {
    enabled: boolean;
    thresholdMinor: number;
    amountMinor: number;
    cardOnFile: boolean;
    /** A declined card is the quiet killer — the phone just stops answering. */
    failedAt: string | null;
    failureReason: string | null;
  };
}

export interface WalletTransaction {
  id: string;
  type: string; // TOPUP | DEBIT | REFUND | ADJUSTMENT
  amountMinor: number; // signed
  balanceAfterMinor: number;
  currency: string;
  purpose?: string | null;
  segments?: number | null;
  description?: string | null;
  createdAt: string;
}

export const walletClient = {
  get: (locationId?: string | null) =>
    apiClient
      .get<WalletSummary>("/v1/wallet", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),

  transactions: (limit = 50, locationId?: string | null) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (locationId) q.set("locationId", locationId);
    return apiClient
      .get<WalletTransaction[]>(`/v1/wallet/transactions?${q.toString()}`)
      .then((r) => r.data);
  },

  // Returns a Stripe Checkout URL to open for payment.
  topup: (amountMinor: number, locationId?: string | null) =>
    apiClient
      .post<{ url: string }>("/v1/wallet/topup", {
        amountMinor,
        locationId: locationId ?? undefined,
      })
      .then((r) => r.data),

  // Keep the line funded without anyone watching the balance. The card is the
  // one saved on an earlier top-up — Stripe keeps it on file for exactly this.
  setAutoTopup: (
    input: {
      enabled: boolean;
      thresholdMinor?: number;
      amountMinor?: number;
    },
    locationId?: string | null,
  ) =>
    apiClient
      .post<WalletSummary>("/v1/wallet/auto-topup", {
        ...input,
        locationId: locationId ?? undefined,
      })
      .then((r) => r.data),

  // Platform admin only: what this shop pays per answered AI call. null puts
  // them back on the standard rate.
  setVoicePrice: (pricePerCallMinor: number | null, locationId?: string | null) =>
    apiClient
      .post<WalletSummary>("/v1/wallet/voice-price", {
        pricePerCallMinor,
        locationId: locationId ?? undefined,
      })
      .then((r) => r.data),
};

/** Format pennies as GBP, e.g. 1234 → "£12.34". */
export function formatGbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}£${(Math.abs(minor) / 100).toFixed(2)}`;
}
