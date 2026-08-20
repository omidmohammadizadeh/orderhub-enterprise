// Phase AW-19 — Marketing campaigns client.

import { apiClient } from "@/lib/api/client";

export type CampaignType =
  | "PERCENTAGE_OFF"
  | "AMOUNT_OFF_ORDER"
  | "PERCENT_OFF_ITEMS"
  | "BOGO"
  | "FREE_ITEM"
  | "FREE_DELIVERY"
  | "HAPPY_HOUR";

export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
export type CampaignAudience = "ALL" | "NEW" | "RETURNING" | "LAPSED";

export interface MarketingCampaign {
  id: string;
  tenantId: string;
  brandId: string;
  name: string;
  description: string | null;
  type: CampaignType;
  status: CampaignStatus;
  audience: CampaignAudience;
  channels: string[];
  percentageOff: number | string | null;
  amountOff: number | string | null;
  minOrder: number | string | null;
  freeItemId: string | null;
  itemIds: string[];
  dailyStartTime: string | null;
  dailyEndTime: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  redemptionCount: number;
  createdAt: string;
  updatedAt: string;
  // Resolved server-side from the campaign's brand. A campaign is scoped to a
  // BRAND, not a location, so "where does this offer run?" is the brand's
  // location set — primary first. Optional because older cached responses (and
  // the create/update endpoints) return the bare row without them.
  brandName?: string | null;
  locations?: Array<{ id: string; name: string }>;
}

export interface CreateCampaignInput {
  brandId: string;
  name: string;
  description?: string;
  type: CampaignType;
  status?: CampaignStatus;
  audience?: CampaignAudience;
  channels?: string[];
  percentageOff?: number;
  amountOff?: number;
  minOrder?: number;
  freeItemId?: string;
  itemIds?: string[];
  dailyStartTime?: string;
  dailyEndTime?: string;
  startsAt?: string;
  endsAt?: string;
  maxRedemptions?: number;
  perCustomerLimit?: number;
}

// Phase MK-INSIGHTS — per-campaign performance, keyed by campaign id.
export interface CampaignMetrics {
  orders: number;
  sales: number;
  discount: number;
  newCustomers: number;
  redemptions: number;
}
export type CampaignMetricsMap = Record<string, CampaignMetrics>;

export const marketingClient = {
  list: (brandId?: string) =>
    apiClient
      .get<MarketingCampaign[]>("/v1/marketing/campaigns", {
        params: brandId ? { brandId } : undefined,
      })
      .then((r) => r.data),
  // Per-campaign Sales/Orders/New-customers over an optional date window
  // (ISO strings). Merged into the campaign list on the Marketing page.
  metrics: (params?: { brandId?: string; from?: string; to?: string }) =>
    apiClient
      .get<CampaignMetricsMap>("/v1/marketing/metrics", {
        params:
          params && (params.brandId || params.from || params.to)
            ? params
            : undefined,
      })
      .then((r) => r.data),
  get: (id: string) =>
    apiClient
      .get<MarketingCampaign>(`/v1/marketing/campaigns/${id}`)
      .then((r) => r.data),
  create: (data: CreateCampaignInput) =>
    apiClient
      .post<MarketingCampaign>("/v1/marketing/campaigns", data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CreateCampaignInput>) =>
    apiClient
      .patch<MarketingCampaign>(`/v1/marketing/campaigns/${id}`, data)
      .then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/marketing/campaigns/${id}`).then((r) => r.data),
  // Receipt QR: storefront URL + live "Scan me to get …" caption for a
  // brand. Used by the tablet print path for marketplace tickets.
  receiptOffer: (brandId: string, locationId: string) =>
    apiClient
      .get<{ url: string | null; caption: string; logoUrl: string | null }>(
        "/v1/marketing/receipt-offer",
        { params: { brandId, locationId } },
      )
      .then((r) => r.data),
};
