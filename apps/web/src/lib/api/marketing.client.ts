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

export const marketingClient = {
  list: (brandId?: string) =>
    apiClient
      .get<MarketingCampaign[]>("/v1/marketing/campaigns", {
        params: brandId ? { brandId } : undefined,
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
      .get<{ url: string | null; caption: string }>(
        "/v1/marketing/receipt-offer",
        { params: { brandId, locationId } },
      )
      .then((r) => r.data),
};
