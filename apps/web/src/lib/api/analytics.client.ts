"use client";
import { apiClient } from "./client";

// Phase AW-24 — Enterprise analytics overview payload.

export interface OverviewSummary {
  grossRevenue: number;
  netRevenue: number;
  subtotal: number;
  discount: number;
  deliveryFees: number;
  taxAmount: number;
  successfulOrders: number;
  cancelledOrders: number;
  failedOrders: number;
  cancelledRevenue: number;
  failedRevenue: number;
  avgOrderValue: number;
  prevGrossRevenue: number;
  prevNetRevenue: number;
  prevSuccessfulOrders: number;
  prevAvgOrderValue: number;
}

export interface AnalyticsOverview {
  generatedAt: string;
  window: { from: string; to: string; prevFrom: string; prevTo: string };
  summary: OverviewSummary;
  revenueTimeline: Array<{
    date: string;
    revenue: number;
    orders: number;
    prevRevenue: number;
  }>;
  byChannel: Array<{
    name: string;
    revenue: number;
    orders: number;
    share: number;
  }>;
  byLocation: Array<{
    id: string;
    name: string;
    revenue: number;
    orders: number;
  }>;
  byBrand: Array<{
    id: string;
    name: string;
    revenue: number;
    orders: number;
  }>;
  topProducts: Array<{ name: string; quantity: number; revenue: number }>;
  topPostcodes: Array<{ postcode: string; orders: number; revenue: number }>;
  weakestPostcodes: Array<{
    postcode: string;
    orders: number;
    revenue: number;
  }>;
  hourlyHeatmap: Array<{
    dayOfWeek: number;
    hour: number;
    orders: number;
    revenue: number;
  }>;
}

export interface OverviewFilters {
  from?: string;
  to?: string;
  locationId?: string;
  brandId?: string;
  channels?: string[];
  fulfillmentTypes?: string[];
}

export const analyticsClient = {
  overview: (f: OverviewFilters) => {
    const params: Record<string, string> = {};
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.locationId) params.locationId = f.locationId;
    if (f.brandId) params.brandId = f.brandId;
    if (f.channels?.length) params.channels = f.channels.join(",");
    if (f.fulfillmentTypes?.length)
      params.fulfillmentTypes = f.fulfillmentTypes.join(",");
    return apiClient
      .get<AnalyticsOverview>("/v1/analytics/overview", { params })
      .then((r) => r.data);
  },
};
