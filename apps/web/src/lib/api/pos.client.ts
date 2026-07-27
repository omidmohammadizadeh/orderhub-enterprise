// Phase AM — POS-specific API clients (delivery zones, promo codes,
// address lookup). Thin wrappers around apiClient that return typed shapes
// the cart panel can consume directly.

import { apiClient } from "./client";

export interface DeliveryZone {
  id: string;
  locationId: string | null;
  brandId: string | null;
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
  listByBrand: (brandId: string) =>
    apiClient
      .get<DeliveryZone[]>("/v1/delivery-zones", { params: { brandId } })
      .then((r) => r.data),
  lookup: (locationId: string, postcode: string) =>
    apiClient
      .get<DeliveryFeeLookup>("/v1/delivery-zones/lookup", {
        params: { locationId, postcode },
      })
      .then((r) => r.data),
  create: (body: {
    locationId?: string;
    brandId?: string;
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

export interface PromoCode {
  id: string;
  tenantId: string;
  code: string;
  description?: string | null;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
  value: string | number;
  minOrderValue: string | number | null;
  maxUses: number | null;
  usedCount: number;
  startAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  locationIds: string[];
}

// Phase AP — Direct online ordering config.

export interface DirectOrderingConfig {
  id: string;
  tenantId: string;
  locationId: string;
  deliveryPrepMinutes: number;
  collectionPrepMinutes: number;
  acceptsCash: boolean;
  acceptsCard: boolean;
  acceptsDelivery: boolean;
  acceptsCollection: boolean;
  scheduleMaxDaysAhead: number;
  scheduleSlotMinutes: number;
  minOrderForDelivery: string | number | null;
  heroImageUrl: string | null;
  showItemImages: boolean;
}

type DirectOrderingPatch = Partial<{
  deliveryPrepMinutes: number;
  collectionPrepMinutes: number;
  acceptsCash: boolean;
  acceptsCard: boolean;
  acceptsDelivery: boolean;
  acceptsCollection: boolean;
  scheduleMaxDaysAhead: number;
  scheduleSlotMinutes: number;
  minOrderForDelivery: number | null;
  heroImageUrl: string | null;
  showItemImages: boolean;
}>;

export const directOrderingClient = {
  get: (locationId: string) =>
    apiClient
      .get<DirectOrderingConfig>("/v1/direct-ordering/config", {
        params: { locationId },
      })
      .then((r) => r.data),
  update: (locationId: string, body: DirectOrderingPatch) =>
    apiClient
      .patch<DirectOrderingConfig>("/v1/direct-ordering/config", body, {
        params: { locationId },
      })
      .then((r) => r.data),
  // Phase AW — brand-keyed variants. Same shape, brandId where the
  // legacy flow used locationId. Used by the BrandSettingsDrawer so
  // each virtual brand at a location carries its own prep times,
  // accepted payment methods, scheduling window, and min order.
  getByBrand: (brandId: string) =>
    apiClient
      .get<DirectOrderingConfig>("/v1/direct-ordering/brand-config", {
        params: { brandId },
      })
      .then((r) => r.data),
  updateByBrand: (brandId: string, body: DirectOrderingPatch) =>
    apiClient
      .patch<DirectOrderingConfig>(
        "/v1/direct-ordering/brand-config",
        body,
        { params: { brandId } },
      )
      .then((r) => r.data),
};

export const promoCodesClient = {
  validate: (body: { code: string; locationId: string; subtotal: number }) =>
    apiClient
      .post<PromoValidateResult>("/v1/promo-codes/validate", body)
      .then((r) => r.data),
  list: (locationId?: string) =>
    apiClient
      .get<PromoCode[]>("/v1/promo-codes", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  create: (body: {
    code: string;
    type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
    value: number;
    description?: string;
    minOrderValue?: number;
    maxUses?: number;
    startAt?: string;
    expiresAt?: string;
    isActive?: boolean;
    locationIds?: string[];
  }) => apiClient.post<PromoCode>("/v1/promo-codes", body).then((r) => r.data),
  update: (id: string, body: any) =>
    apiClient.patch<PromoCode>(`/v1/promo-codes/${id}`, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/promo-codes/${id}`),
};

export type AddressProvider =
  | "mapbox"
  | "google"
  | "getaddress"
  | "osm"
  | "postcodes_io"
  | "ideal_postcodes"
  | "loqate"
  | "postcoder"
  | "royal_mail"
  | "manual";

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
  provider: AddressProvider;
}

export interface AddressProviderStatus {
  searchProvider: AddressProvider;
  postcodeProvider: AddressProvider;
}

export const addressLookupClient = {
  status: () =>
    apiClient
      .get<AddressProviderStatus>("/v1/address-lookup/status")
      .then((r) => r.data),
  search: (q: string, country: string = "gb", limit: number = 5) =>
    apiClient
      .get<{
        provider: AddressProvider;
        suggestions: AddressSuggestion[];
      }>("/v1/address-lookup/search", { params: { q, country, limit } })
      .then((r) => r.data),
  postcode: (postcode: string) =>
    apiClient
      .get<{
        provider: AddressProvider;
        suggestions: AddressSuggestion[];
      }>("/v1/address-lookup/postcode", { params: { postcode } })
      .then((r) => r.data),
  // Resolve a Google Places id (returned in AddressSuggestion.id when
  // provider === "google") to a fully-structured address.
  details: (id: string) =>
    apiClient
      .get<{ suggestion: AddressSuggestion | null }>(
        "/v1/address-lookup/details",
        { params: { id } },
      )
      .then((r) => r.data),
};

// ── POS Payment Link ─────────────────────────────────────────────────────────
// Generate a hosted Stripe checkout URL for an unpaid order (shown as a QR /
// copyable link / SMS). The order auto-flips to PAID via webhook when paid.
export const paymentLinkClient = {
  create: (orderId: string) =>
    apiClient
      .post<{ url: string; smsConfigured: boolean }>(
        `/v1/payments/orders/${orderId}/payment-link`,
      )
      .then((r) => r.data),
  // Text the link to the customer. Billable — meters an sms_messages row.
  sendSms: (orderId: string, phone: string) =>
    apiClient
      .post<{ ok: true }>(
        `/v1/payments/orders/${orderId}/payment-link/sms`,
        { phone },
      )
      .then((r) => r.data),
};
