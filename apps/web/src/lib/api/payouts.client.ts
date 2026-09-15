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
  /**
   * Which kind of Stripe login this merchant has, once we've learned it.
   * "full" means their own Stripe account — we can't open it for them.
   * Null until the first attempt tells us.
   */
  dashboardType: "express" | "full" | "none" | null;
}

/** When Stripe pays a shop out. `manual` exists at Stripe but we never set it. */
export interface PayoutSchedule {
  /** Whose payout day this is — a tenant can have several payout accounts. */
  accountId: string;
  accountLabel: string;
  interval: "daily" | "weekly" | "monthly" | "manual" | string;
  /** Only on a weekly schedule — "monday" … "friday". */
  weeklyAnchor: string | null;
  /** Only on a monthly schedule — 1–31. */
  monthlyAnchor: number | null;
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

export interface PayoutBreakdownLine {
  id: string;
  type: string;
  gross: number;
  fee: number;
  net: number;
  currency: string;
  description: string | null;
  createdAt: string;
  order: {
    id: string;
    reference: string | null;
    customerName: string | null;
    total: string;
    placedAt: string;
  } | null;
}

export interface PayoutBreakdown {
  payoutId: string;
  accountId: string;
  accountLabel: string;
  currency: string;
  sales: number;
  refunds: number;
  stripeFees: number;
  commission: number;
  other: number;
  total: number;
  orderCount: number;
  /** Stripe pages at 100 — the lines shown won't total to `total`. */
  truncated: boolean;
  lines: PayoutBreakdownLine[];
}

// `locationId` is the sidebar's shop scope, sent on every read so this page
// shows the same shop the rest of the dashboard is showing. It only ever
// narrows: the API checks it against the caller's own assignments.
const scoped = (accountId?: string, locationId?: string) => {
  const params: Record<string, string> = {};
  if (accountId) params.accountId = accountId;
  if (locationId) params.locationId = locationId;
  return Object.keys(params).length ? params : undefined;
};

export const payoutsClient = {
  accounts: (locationId?: string) =>
    apiClient
      .get<PayoutAccount[]>("/v1/payouts/accounts", {
        params: scoped(undefined, locationId),
      })
      .then((r) => r.data),

  list: (accountId?: string, locationId?: string) =>
    apiClient
      .get<{ accounts: PayoutAccount[]; payouts: PayoutRow[] }>("/v1/payouts", {
        params: scoped(accountId, locationId),
      })
      .then((r) => r.data),

  balance: (accountId?: string, locationId?: string) =>
    apiClient
      .get<PayoutBalance>("/v1/payouts/balance", {
        params: scoped(accountId, locationId),
      })
      .then((r) => r.data),

  breakdown: (payoutId: string, accountId?: string, locationId?: string) =>
    apiClient
      .get<PayoutBreakdown>(`/v1/payouts/${payoutId}/breakdown`, {
        params: scoped(accountId, locationId),
      })
      .then((r) => r.data),

  // When Stripe currently pays this shop out. Null when Stripe isn't
  // configured, or when the schedule can't be read — the page just hides the
  // control rather than showing a wrong day.
  schedule: (accountId?: string, locationId?: string) =>
    apiClient
      .get<PayoutSchedule | null>("/v1/payouts/schedule", {
        params: scoped(accountId, locationId),
      })
      .then((r) => r.data),

  updateSchedule: (body: {
    accountId?: string;
    locationId?: string;
    interval: "daily" | "weekly" | "monthly";
    weeklyAnchor?: string;
    monthlyAnchor?: number;
  }) =>
    apiClient
      .patch<PayoutSchedule>("/v1/payouts/schedule", body)
      .then((r) => r.data),

  // A short-lived AccountSession secret for Stripe's embedded panel, where the
  // owner edits their bank account without leaving the dashboard — and without
  // the account number passing through OrderHub.
  managementSession: (accountId?: string, locationId?: string) =>
    apiClient
      .post<{ stripeAccountId: string; clientSecret: string }>(
        "/v1/payouts/management-session",
        { accountId, locationId },
      )
      .then((r) => r.data),

  // Returns a single-use Stripe URL — open it immediately, never store it.
  // `kind` says which door it opens: the merchant's Express dashboard, the
  // Stripe-hosted update form (for accounts with no dashboard of their own),
  // or onboarding when the account was never finished.
  dashboardLink: (accountId?: string, locationId?: string) =>
    apiClient
      .post<{
        url: string;
        kind: "DASHBOARD" | "ONBOARDING" | "ACCOUNT_UPDATE" | "EXTERNAL";
        message?: string;
      }>(
        "/v1/payouts/dashboard-link",
        { accountId, locationId },
      )
      .then((r) => r.data),
};
