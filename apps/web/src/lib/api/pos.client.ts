// Phase AM — POS-specific API clients (delivery zones, promo codes,
// address lookup). Thin wrappers around apiClient that return typed shapes
// the cart panel can consume directly.

import { apiClient } from "./client";

export interface DeliveryZone {
  id: string;
  locationId: string;
  postcodePrefix: string;
  fee: string | number; // Prisma serialises Decimal → string
  minOrderValue: string | number | null;
  isActive: boolean;
}

export interface DeliveryFeeLookup {
  matched: boolean;
  zoneId?: string;
  postcodePrefix?: string;
  fee: number;
  minOrderValue?: number | null;
}

export const deliveryZonesClient = {
  list: (locationId: string) =>
    apiClient
      .get<DeliveryZone[]>("/v1/delivery-zones", { params: { locationId } })
      .then((r) => r.data),
  lookup: (locationId: string, postcode: string) =>
    apiClient
      .get<DeliveryFeeLookup>("/v1/delivery-zones/lookup", {
        params: { locationId, postcode },
      })
      .then((r) => r.data),
  create: (body: {
    locationId: string;
    postcodePrefix: string;
    fee: number;
    minOrderValue?: number;
    isActive?: boolean;
  }) => apiClient.post<DeliveryZone>("/v1/delivery-zones", body).then((r) => r.data),
  update: (
    id: string,
    body: Partial<{
      postcodePrefix: string;
      fee: number;
      minOrderValue: number | null;
      isActive: boolean;
    }>,
  ) =>
    apiClient
      .patch<DeliveryZone>(`/v1/delivery-zones/${id}`, body)
      .then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/delivery-zones/${id}`),
};

export interface PromoValidateResult {
  valid: boolean;
  reason?: string;
  promoId?: string;
  code?: string;
  type?: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
  value?: number;
  discountAmount?: number;
  freeDelivery?: boolean;
}

export const promoCodesClient = {
  validate: (body: { code: string; locationId: string; subtotal: number }) =>
    apiClient
      .post<PromoValidateResult>("/v1/promo-codes/validate", body)
      .then((r) => r.data),
  list: () => apiClient.get("/v1/promo-codes").then((r) => r.data),
  create: (body: any) =>
    apiClient.post("/v1/promo-codes", body).then((r) => r.data),
  update: (id: string, body: any) =>
    apiClient.patch(`/v1/promo-codes/${id}`, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/promo-codes/${id}`),
};

export interface AddressSuggestion {
  id: string;
  label: string;
  line1: string;
  line2?: string;
  city?: string;
  postcode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  provider: "mapbox" | "google" | "manual";
}

export const addressLookupClient = {
  provider: () =>
    apiClient
      .get<{ provider: "mapbox" | "google" | "manual" }>("/v1/address-lookup/provider")
      .then((r) => r.data),
  search: (q: string, country: string = "gb", limit: number = 5) =>
    apiClient
      .get<{
        provider: "mapbox" | "google" | "manual";
        suggestions: AddressSuggestion[];
      }>("/v1/address-lookup/search", { params: { q, country, limit } })
      .then((r) => r.data),
};
