// Wallet — prepaid balance clients top up to send payment links & marketing
// texts. Balance is billed per Twilio segment. All amounts are MINOR units
// (pennies) end-to-end to avoid float drift.

import { apiClient } from "./client";

export interface WalletSummary {
  balanceMinor: number;
  currency: string;
  pricePerSegmentMinor: number;
  lowBalanceThresholdMinor: number;
  lowBalance: boolean;
  smsConfigured: boolean;
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
};

/** Format pennies as GBP, e.g. 1234 → "£12.34". */
export function formatGbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}£${(Math.abs(minor) / 100).toFixed(2)}`;
}
