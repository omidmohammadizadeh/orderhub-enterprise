// Eat For Less — our own marketplace app.
//
// Two audiences: a shop managing its own listing from OrderHub
// (Platforms → Eat For Less), and the platform team in the Eat For Less
// Console (/efl-console, PLATFORM_ADMIN only). Commission and approval are
// the Console's; a shop only ever reads them.

import { apiClient } from "./client";

export type EflDeliveryMode = "OWN_DRIVERS" | "COURIER" | "OWN_THEN_COURIER";
export type EflListingStatus = "PENDING" | "APPROVED" | "SUSPENDED";

export interface EflShopListing {
  locationId: string;
  exists: boolean;
  listed: boolean;
  status: EflListingStatus;
  hiddenReason: string | null;
  live: boolean;
  commissionPercent: number;
  brandId: string | null;
  deliveryMode: EflDeliveryMode;
  acceptsDelivery: boolean;
  acceptsCollection: boolean;
  description: string | null;
  heroImageUrl: string | null;
  logoUrl: string | null;
  cuisines: string[];
}

export type EflShopListingUpdate = Partial<
  Pick<
    EflShopListing,
    | "listed"
    | "brandId"
    | "deliveryMode"
    | "acceptsDelivery"
    | "acceptsCollection"
    | "description"
    | "heroImageUrl"
    | "logoUrl"
    | "cuisines"
  >
>;

export interface EflAdminListing {
  id: string;
  locationId: string;
  shopName: string | null;
  town: string | null;
  listed: boolean;
  status: EflListingStatus;
  hiddenReason: string | null;
  live: boolean;
  commissionPercent: number;
  commissionIsDefault: boolean;
  deliveryMode: EflDeliveryMode;
  placedOnMap: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export interface EflConfig {
  defaultCommissionPercent: number;
  pinMinOrderTotal: number;
  pinForNewCustomers: boolean;
  firstOrderMaxTotal: number;
  maxOrdersPerHour: number;
  minHygieneRating: number;
}

export interface EflSummary {
  listings: { total: number; live: number; waitingApproval: number; suspended: number; hidden: number };
  today: { orders: number; sales: number; commission: number };
}

/** Cuisines a shop can tag itself with — the same set the app's cuisine row shows. */
export const EFL_CUISINES = [
  "Pizza",
  "Burgers",
  "Kebab",
  "Indian",
  "Chicken",
  "Chinese",
  "Fast food",
  "Desserts",
  "Breakfast",
  "Healthy",
] as const;

export type EflApplicationStatus = "NEW" | "WAITING_INFO" | "APPROVED" | "DECLINED";

export interface EflApplicationInput {
  businessName: string;
  companyNumber?: string;
  cuisine?: string;
  addressLine1: string;
  city: string;
  postcode: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  menuUrl?: string;
  hygieneUrl?: string;
  /** data: URLs, 3.5 MB each at most. */
  idDocument?: string;
  bankStatement?: string;
}

/** What the automatic checks found. `state` drives the tick/cross. */
export interface EflApplicationChecks {
  checkedAt?: string;
  companiesHouse?: { state: "OK" | "INACTIVE" | "NOT_FOUND" | "NOT_CHECKED" | "NOT_GIVEN"; name?: string | null };
  hygiene?: {
    state: "OK" | "BELOW_MINIMUM" | "NOT_FOUND";
    minimum: number;
    rating?: string;
    businessName?: string;
    establishmentId?: string;
  };
}

export interface EflApplicationRow {
  id: string;
  status: EflApplicationStatus;
  businessName: string;
  city: string;
  createdAt: string;
  checks: EflApplicationChecks;
}

export interface EflApplication extends EflApplicationRow {
  companyNumber: string | null;
  cuisine: string | null;
  addressLine1: string;
  postcode: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  menuUrl: string | null;
  hygieneUrl: string | null;
  hasIdDocument: boolean;
  hasBankStatement: boolean;
  /** Signed links that stop working after 10 minutes. */
  idDocUrl: string | null;
  bankDocUrl: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

export interface EflHygieneShop {
  listingId: string;
  shopName: string | null;
  town: string | null;
  fsaEstablishmentId: string | null;
  rating: string | null;
  checkedAt: string | null;
  belowMinimum: boolean;
  hiddenForHygiene: boolean;
}

export const eflPartnerClient = {
  apply: (input: EflApplicationInput) =>
    apiClient.post<{ id: string; reference: string }>("/v1/efl/applications", input).then((r) => r.data),
};

export const eflClient = {
  getListing: (locationId: string) =>
    apiClient.get<EflShopListing>(`/v1/efl/listing/${locationId}`).then((r) => r.data),

  updateListing: (locationId: string, patch: EflShopListingUpdate) =>
    apiClient.put<EflShopListing>(`/v1/efl/listing/${locationId}`, patch).then((r) => r.data),
};

export const eflAdminClient = {
  summary: () => apiClient.get<EflSummary>("/v1/admin/efl/summary").then((r) => r.data),

  listings: () => apiClient.get<EflAdminListing[]>("/v1/admin/efl/listings").then((r) => r.data),

  updateListing: (
    id: string,
    patch: { status?: EflListingStatus; commissionPercent?: number | null; hiddenReason?: string | null },
  ) => apiClient.patch<EflAdminListing>(`/v1/admin/efl/listings/${id}`, patch).then((r) => r.data),

  placeOnMap: () =>
    apiClient
      .post<{ checked: number; placed: number }>("/v1/admin/efl/listings/place-on-map")
      .then((r) => r.data),

  config: () => apiClient.get<EflConfig>("/v1/admin/efl/config").then((r) => r.data),

  updateConfig: (patch: Partial<EflConfig>) =>
    apiClient.put<EflConfig>("/v1/admin/efl/config", patch).then((r) => r.data),

  applications: () =>
    apiClient.get<EflApplicationRow[]>("/v1/admin/efl/applications").then((r) => r.data),

  application: (id: string) =>
    apiClient.get<EflApplication>(`/v1/admin/efl/applications/${id}`).then((r) => r.data),

  recheckApplication: (id: string) =>
    apiClient.post<EflApplicationChecks>(`/v1/admin/efl/applications/${id}/recheck`).then((r) => r.data),

  decideApplication: (id: string, status: "APPROVED" | "DECLINED" | "WAITING_INFO", note?: string) =>
    apiClient.patch<EflApplication>(`/v1/admin/efl/applications/${id}`, { status, note }).then((r) => r.data),

  hygiene: () =>
    apiClient.get<{ minimum: number; shops: EflHygieneShop[] }>("/v1/admin/efl/hygiene").then((r) => r.data),

  hygieneCheckNow: () =>
    apiClient
      .post<{ checked: number; hidden: number; restored: number }>("/v1/admin/efl/hygiene/check-now")
      .then((r) => r.data),

  hygieneLink: (listingId: string, url?: string) =>
    apiClient.post<EflHygieneShop>(`/v1/admin/efl/hygiene/${listingId}/link`, url ? { url } : {}).then((r) => r.data),
};
