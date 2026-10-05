// Marketing → Promo codes: every code, its results, and where it's used.

import { apiClient } from "./client";

export type PromoType = "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
export type PromoStatus = "ACTIVE" | "PAUSED" | "SCHEDULED" | "EXPIRED" | "USED_UP";

export interface PromoOverview {
  id: string;
  code: string;
  description: string | null;
  type: PromoType;
  value: number;
  minOrderValue: number | null;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
  usedCount: number;
  startAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  locationIds: string[];
  showOnPos: boolean;
  createdAt: string;
  status: PromoStatus;
  canManage: boolean;
  results: { orders: number; revenue: number; discount: number; lastUsedAt: string | null };
  usedIn: { kind: "campaign" | "automation"; id: string; name: string; status: string }[];
}

export interface PromoOrder {
  id: string;
  reference: string;
  createdAt: string;
  total: number;
  discount: number;
  source: string;
  status: string;
  customer: string | null;
  locationName: string | null;
}

export interface PromoInput {
  code: string;
  type: PromoType;
  value: number;
  description?: string | null;
  minOrderValue?: number | null;
  maxUses?: number | null;
  maxUsesPerCustomer?: number | null;
  startAt?: string | null;
  expiresAt?: string | null;
  isActive?: boolean;
  locationIds: string[];
  showOnPos: boolean;
}

export const promoCodesPageClient = {
  overview: (locationId?: string | null) =>
    apiClient
      .get<PromoOverview[]>("/v1/promo-codes/overview", { params: locationId ? { locationId } : {} })
      .then((r) => r.data),
  orders: (id: string) => apiClient.get<PromoOrder[]>(`/v1/promo-codes/${id}/orders`).then((r) => r.data),
  create: (body: PromoInput) => apiClient.post("/v1/promo-codes", body).then((r) => r.data),
  update: (id: string, body: Partial<PromoInput>) => apiClient.patch(`/v1/promo-codes/${id}`, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/promo-codes/${id}`).then((r) => r.data),
};
