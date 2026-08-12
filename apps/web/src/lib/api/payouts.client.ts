import { apiClient } from "./client";

export interface PayoutAccount {
  id: string;
  stripeAccountId: string;
  /** Shop or brand name — what the owner calls this pot of money. */
  label: string;
  locationId: string | null;
  brandId: string | null;
  scope: "LOCATION" | "BRAND" | "TENANT";
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  onboardingComplete: boolean;
}

export interface PayoutRow {
  id: string;
  stripePayoutId: string;
  amount: string;
  currency: string;
  status: "PENDING" | "IN_TRANSIT" | "PAID" | "FAILED" | "CANCELLED";
  arrivalDate: string | null;
  description: string | null;
  createdAt: string;
  accountId: string | null;
  accountLabel: string | null;
}

export interface PayoutBalance {
  accountId: string;
  currency: string;
  available: number | null;
  pending: number | null;
  inTransit: number | null;
  nextPayout?: { amount: number; arrivalDate: string | null } | null;
  /** Set when Stripe couldn't be reached — the page still renders history. */
  unavailableReason?: string;
}

export const payoutsClient = {
  accounts: () =>
    apiClient.get<PayoutAccount[]>("/v1/payouts/accounts").then((r) => r.data),

  list: (accountId?: string) =>
    apiClient
      .get<{ accounts: PayoutAccount[]; payouts: PayoutRow[] }>("/v1/payouts", {
        params: accountId ? { accountId } : undefined,
      })
      .then((r) => r.data),

  balance: (accountId?: string) =>
    apiClient
      .get<PayoutBalance>("/v1/payouts/balance", {
        params: accountId ? { accountId } : undefined,
      })
      .then((r) => r.data),

  // Returns a single-use Stripe URL — open it immediately, never store it.
  // `kind` says which door it opens: the merchant's Express dashboard, or
  // Stripe onboarding when the account was never finished.
  dashboardLink: (accountId?: string) =>
    apiClient
      .post<{ url: string; kind: "DASHBOARD" | "ONBOARDING" }>(
        "/v1/payouts/dashboard-link",
        { accountId },
      )
      .then((r) => r.data),
};
