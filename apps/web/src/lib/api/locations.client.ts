import { apiClient } from "./client";

// Phase AN — Location client extended with general-tab fields, opening
// hours, busy mode, slug generation. The Phase AJ LocationSelector still
// reads the same /v1/locations endpoint, just from the extended Location
// shape — extra fields are optional so older callers stay typed.

export interface LocationSummary {
  id: string;
  name: string;
  brandId: string;
  brandName?: string | null;
  isActive: boolean;
  shopCode?: string | null;
}

export type LocationStatus = "active" | "suspended" | "closed";
export type CustomDomainStatus = "not_configured" | "pending" | "verified" | "failed";
export type AppFeeMode = "none" | "fixed_only" | "percentage_only" | "fixed_and_percentage";

export interface Location {
  id: string;
  brandId: string;
  brand?: { id: string; name: string };
  name: string;
  phone?: string | null;
  timezone: string;
  isActive: boolean;
  status: LocationStatus;
  about?: string | null;
  logoUrl?: string | null;
  /** Phase AP-5 — Google Business Profile review URL. */
  googleReviewUrl?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country: string;
  customDomain?: string | null;
  customDomainStatus: CustomDomainStatus;
  onlineOrderingSlug?: string | null;
  stripeConnectedAccountId?: string | null;
  // Phase AU — HubRise per-location storage. Token itself is never
  // returned; `hubriseConnected` reflects whether one is on file.
  hubriseCatalogId?: string | null;
  hubriseLocationId?: string | null;
  hubriseConnected?: boolean;
  hubriseConnectedAt?: string | null;
  applicationFeeFixedAmount?: string | number | null;
  applicationFeePercentage?: string | number | null;
  applicationFeeMode: AppFeeMode;
  busyMode: boolean;
  busyModeJson?: Record<string, any>;
  openingHours?: OpeningHoursMap;
  _count?: { platformConnections?: number };
}

export interface OpeningSlot {
  from: string;
  to: string;
}
export interface DaySchedule {
  enabled: boolean;
  slots: OpeningSlot[];
}
export type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";
export type OpeningHoursMap = Record<WeekdayKey, DaySchedule>;

export interface BusyModeInput {
  enabled: boolean;
  reason?: string;
  until?: string | null;
  affectedPlatforms?: string[];
}

export const WEEKDAY_LABELS: Array<[WeekdayKey, string]> = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
];

export function emptyOpeningHours(): OpeningHoursMap {
  return {
    monday: { enabled: false, slots: [] },
    tuesday: { enabled: false, slots: [] },
    wednesday: { enabled: false, slots: [] },
    thursday: { enabled: false, slots: [] },
    friday: { enabled: false, slots: [] },
    saturday: { enabled: false, slots: [] },
    sunday: { enabled: false, slots: [] },
  };
}

export const locationsClient = {
  list: () => apiClient.get<Location[]>("/v1/locations").then((r) => r.data),
  get: (id: string) => apiClient.get<Location>(`/v1/locations/${id}`).then((r) => r.data),
  create: (body: {
    brandId: string;
    name: string;
    address: { line1: string; line2?: string; city: string; postcode: string; country?: string };
    phone?: string;
    timezone?: string;
  }) => apiClient.post<Location>("/v1/locations", body).then((r) => r.data),
  update: (id: string, body: Partial<Location> & { addressLine1?: string }) =>
    apiClient.patch<Location>(`/v1/locations/${id}`, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/locations/${id}`),
  onlineUrl: (id: string) =>
    apiClient
      .get<{ slug: string | null; url: string | null }>(`/v1/locations/${id}/online-url`)
      .then((r) => r.data),
  generateSlug: (id: string, name?: string) =>
    apiClient
      .post<{ slug: string; url: string }>(`/v1/locations/${id}/generate-slug`, { name })
      .then((r) => r.data),
  getOpeningHours: (id: string) =>
    apiClient.get<OpeningHoursMap>(`/v1/locations/${id}/opening-hours`).then((r) => r.data),
  setOpeningHours: (id: string, hours: OpeningHoursMap) =>
    apiClient.patch(`/v1/locations/${id}/opening-hours`, hours).then((r) => r.data),
  applyHoursTo: (id: string, locationIds: string[]) =>
    apiClient
      .post<{ applied: number }>(`/v1/locations/${id}/opening-hours/apply-to`, { locationIds })
      .then((r) => r.data),
  setBusyMode: (id: string, body: BusyModeInput) =>
    apiClient.patch<Location>(`/v1/locations/${id}/busy-mode`, body).then((r) => r.data),
};

// ── Brand client ──
export interface Brand {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description?: string | null;
  cuisine?: string | null;
  logoUrl?: string | null;
  isActive: boolean;
  isSuspended: boolean;
  primaryLocationId?: string | null;
  // Phase AS-6 — brand-level public storefront
  onlineOrderingSlug?: string | null;
  directOrderingEnabled?: boolean;
  about?: string | null;
  _count?: { platformConnections?: number; locations?: number };
}

export const brandsClient = {
  list: (locationId?: string) =>
    apiClient
      .get<Brand[]>("/v1/brands", { params: locationId ? { locationId } : undefined })
      .then((r) => r.data),
  create: (body: {
    name: string;
    slug?: string;
    description?: string;
    cuisine?: string;
    logoUrl?: string;
    primaryLocationId?: string;
  }) => apiClient.post<Brand>("/v1/brands", body).then((r) => r.data),
  update: (id: string, body: Partial<Brand>) =>
    apiClient.patch<Brand>(`/v1/brands/${id}`, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/brands/${id}`),
};

// ── Brand-platform connections ──
export type PlatformId =
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "HUBRISE"
  | "STUART"
  | "UBER_DIRECT";

export type ConnectionStatus =
  | "not_connected"
  | "pending"
  | "connected"
  | "suspended"
  | "error";

export interface BrandPlatformConnection {
  id: string | null;
  tenantId: string;
  brandId: string;
  locationId: string | null;
  platform: PlatformId;
  status: ConnectionStatus;
  externalStoreId: string | null;
  externalBrandId: string | null;
  integrationId: string | null;
  lastSyncAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  metadata: Record<string, any>;
}

export const brandConnectionsClient = {
  listForBrand: (brandId: string) =>
    apiClient
      .get<BrandPlatformConnection[]>("/v1/brand-connections", { params: { brandId } })
      .then((r) => r.data),
  upsert: (body: {
    brandId: string;
    locationId: string;
    platform: PlatformId;
    status?: ConnectionStatus;
    externalStoreId?: string | null;
    externalBrandId?: string | null;
    integrationId?: string | null;
  }) =>
    apiClient
      .post<BrandPlatformConnection>("/v1/brand-connections", body)
      .then((r) => r.data),
  disconnect: (id: string) =>
    apiClient.patch(`/v1/brand-connections/${id}/disconnect`).then((r) => r.data),
};
