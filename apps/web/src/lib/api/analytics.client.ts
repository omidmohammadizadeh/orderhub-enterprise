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

/** How the takings were settled. Cash vs card, plus what is still owed. */
export interface PaymentMix {
  cash: { orders: number; revenue: number };
  card: { orders: number; revenue: number };
  /** Collection orders not yet paid for — cash vs card unknown until arrival. */
  pending: { orders: number; revenue: number };
  other: { orders: number; revenue: number };
  paidOrders: number;
  paidRevenue: number;
  unpaidOrders: number;
  unpaidRevenue: number;
  byMethod: Array<{
    method: string;
    group: "CASH" | "CARD" | "PENDING" | "OTHER";
    orders: number;
    revenue: number;
  }>;
}

export interface AnalyticsOverview {
  generatedAt: string;
  window: { from: string; to: string; prevFrom: string; prevTo: string };
  summary: OverviewSummary;
  paymentMix: PaymentMix;
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
    cashRevenue: number;
    cashOrders: number;
    cardRevenue: number;
    cardOrders: number;
    pendingRevenue: number;
    otherRevenue: number;
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
  /** Count test + simulated orders too (platform admins only). */
  includeTest?: boolean;
  from?: string;
  to?: string;
  locationId?: string;
  brandId?: string;
  channels?: string[];
  fulfillmentTypes?: string[];
}

export interface CustomerInsights {
  generatedAt: string;
  window: { from: string; to: string; prevFrom: string; prevTo: string };
  summary: { total: number; prevTotal: number; revenue: number };
  groups: {
    new: GroupDetail;
    occasional: GroupDetail;
    frequent: GroupDetail;
  };
  byShop: Array<{
    locationId: string;
    name: string;
    address: string | null;
    new: number;
    occasional: number;
    frequent: number;
    total: number;
  }>;
  trends: Array<{
    date: string;
    all: number;
    new: number;
    occasional: number;
    frequent: number;
  }>;
}

export interface GroupDetail {
  customerCount: number;
  prevCustomerCount: number;
  share: number;
  revenue: number;
  revenueShare: number;
  avgOrderValue: number;
  orderCount: number;
}

export interface WalkInReport {
  orders: number;
  revenue: number;
  avgOrderValue: number;
  paidOrders: number;
  unpaid: number;
  byPaymentMethod: Array<{ method: string; count: number; revenue: number }>;
}

export interface DineInReport {
  orders: number;
  revenue: number;
  serviceCharge: number;
  covers: number;
  ordersWithCovers: number;
  spendPerHead: number;
  avgOrderValue: number;
  avgTableMinutes: number;
  unpaid: number;
  voids: { count: number; value: number };
  comps: { count: number; value: number };
}

export const analyticsClient = {
  dineIn: (f: { startDate?: string; endDate?: string; locationId?: string }) => {
    const params: Record<string, string> = {};
    if (f.startDate) params.startDate = f.startDate;
    if (f.endDate) params.endDate = f.endDate;
    if (f.locationId) params.locationId = f.locationId;
    return apiClient
      .get<DineInReport>("/v1/analytics/dine-in", { params })
      .then((r) => r.data);
  },

  walkIn: (f: { startDate?: string; endDate?: string; locationId?: string }) => {
    const params: Record<string, string> = {};
    if (f.startDate) params.startDate = f.startDate;
    if (f.endDate) params.endDate = f.endDate;
    if (f.locationId) params.locationId = f.locationId;
    return apiClient
      .get<WalkInReport>("/v1/analytics/walk-in", { params })
      .then((r) => r.data);
  },

  customerInsights: (f: { from?: string; to?: string; locationId?: string }) => {
    const params: Record<string, string> = {};
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.locationId) params.locationId = f.locationId;
    return apiClient
      .get<CustomerInsights>("/v1/analytics/customer-insights", { params })
      .then((r) => r.data);
  },
  overview: (f: OverviewFilters) => {
    const params: Record<string, string> = {};
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.locationId) params.locationId = f.locationId;
    if (f.brandId) params.brandId = f.brandId;
    if (f.channels?.length) params.channels = f.channels.join(",");
    if (f.fulfillmentTypes?.length)
      params.fulfillmentTypes = f.fulfillmentTypes.join(",");
    // Platform admins only; the API ignores it for everyone else.
    if (f.includeTest) params.includeTest = "true";
    return apiClient
      .get<AnalyticsOverview>("/v1/analytics/overview", { params })
      .then((r) => r.data);
  },
};
