// Admin → Auto dispatch. Rules that book a third-party courier (Stuart, Uber
// Direct, JET Go, Yango) on their own — a fixed provider, or the cheapest live
// quote — at a chosen moment. Platform-admin only.

import { apiClient } from "./client";

export type AutoDispatchProvider = "STUART" | "UBER_DIRECT" | "JET_GO" | "YANGO";
export type AutoDispatchStrategy = "FIXED" | "CHEAPEST";
export type AutoDispatchTrigger = "ON_ACCEPT" | "ON_READY" | "BEFORE_READY";

export const PROVIDER_LABEL: Record<AutoDispatchProvider, string> = {
  STUART: "Stuart",
  UBER_DIRECT: "Uber Direct",
  JET_GO: "JET Go",
  YANGO: "Yango",
};

export interface AutoDispatchRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  locationId: string | null;
  brandIds: string[];
  channels: string[];
  strategy: AutoDispatchStrategy;
  providers: AutoDispatchProvider[];
  fallback: boolean;
  trigger: AutoDispatchTrigger;
  delayMinutes: number;
  maxPriceMinor: number | null;
  dryRun: boolean;
  enabledAt: string | null;
  createdAt: string;
}

export type RuleInput = Omit<AutoDispatchRule, "id" | "enabledAt" | "createdAt">;

/** ready | off | not_set_up | no_collect_point | estimate_only | error */
export type ProviderReadiness = Record<AutoDispatchProvider, string>;

export interface AutoDispatchOptions {
  locations: {
    id: string;
    name: string;
    country: string;
    currency: string;
    providers: ProviderReadiness;
  }[];
  brands: { id: string; name: string }[];
  channels: string[];
  providers: AutoDispatchProvider[];
}

export interface AutoDispatchQuote {
  provider: AutoDispatchProvider;
  ok: boolean;
  amountMinor: number | null;
  currency: string | null;
  canDispatch: boolean;
  deliverBy?: string | null;
  error?: string | null;
}

export interface AutoDispatchOrder {
  id: string;
  locationId: string;
  brandId: string | null;
  orderSource: string;
  status: string;
  fulfillmentType: string;
  displayId: string | null;
  orderNumber: number | null;
  customerName: string | null;
  courierJobId: string | null;
  createdAt: string;
  location?: { name: string } | null;
}

export interface AutoDispatchPreview {
  order: AutoDispatchOrder;
  ineligible: string | null;
  rule: { id: string; name: string; strategy: AutoDispatchStrategy } | null;
  dueAt: string | null;
  quotes: AutoDispatchQuote[];
  wouldChoose: AutoDispatchProvider | null;
  tryOrder: AutoDispatchProvider[];
}

export interface AutoDispatchRun {
  id: string;
  orderId: string;
  locationId: string;
  ruleId: string;
  status: "SCHEDULED" | "RUNNING" | "DISPATCHED" | "DRY_RUN" | "FAILED" | "SKIPPED";
  dueAt: string;
  attempts: number;
  quotes: AutoDispatchQuote[] | null;
  provider: AutoDispatchProvider | null;
  priceMinor: number | null;
  jobId: string | null;
  error: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const BASE = "/v1/admin/auto-dispatch";

export const autoDispatchClient = {
  options: () => apiClient.get<AutoDispatchOptions>(`${BASE}/options`).then((r) => r.data),
  rules: () => apiClient.get<AutoDispatchRule[]>(`${BASE}/rules`).then((r) => r.data),
  create: (input: RuleInput) =>
    apiClient.post<AutoDispatchRule>(`${BASE}/rules`, input).then((r) => r.data),
  update: (id: string, input: Partial<RuleInput>) =>
    apiClient.patch<AutoDispatchRule>(`${BASE}/rules/${id}`, input).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`${BASE}/rules/${id}`).then((r) => r.data),
  runs: () => apiClient.get<AutoDispatchRun[]>(`${BASE}/runs`).then((r) => r.data),
  orders: () => apiClient.get<AutoDispatchOrder[]>(`${BASE}/orders`).then((r) => r.data),
  preview: (orderId: string) =>
    apiClient.post<AutoDispatchPreview>(`${BASE}/orders/${orderId}/preview`).then((r) => r.data),
};
