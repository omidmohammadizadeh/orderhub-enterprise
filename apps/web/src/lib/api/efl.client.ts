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
  /** Where Monday statements go; null = the account owner's email. */
  statementEmail: string | null;
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
    | "statementEmail"
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
  /** One of the shop's own OrderHub devices connected in the last 2 minutes. */
  online: boolean;
  lastDeviceSeenAt: string | null;
  offlineSince: string | null;
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
  listings: { total: number; live: number; waitingApproval: number; suspended: number; hidden: number; offline: number };
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

// ── Sponsored ads, statements, campaigns (Phase 5) ─────────────────────

export interface EflAdCampaign {
  active: boolean;
  weeklyBudget: number;
  maxBid: number;
  pausedByAdmin: boolean;
}

export interface EflAdWeek {
  shows: number;
  taps: number;
  spent: number;
  orders: number;
}

export interface EflShopAds {
  campaign: EflAdCampaign | null;
  thisWeek: EflAdWeek;
  /** Ad spend not yet taken back from orders, in pounds. */
  owed: number;
}

export interface EflAdminAdRow extends EflAdCampaign {
  listingId: string;
  shopName: string | null;
  town: string | null;
  thisWeek: EflAdWeek;
  owed: number;
}

export interface EflStatementLine {
  orderId: string;
  ref: string;
  placedAt: string;
  fulfillment: "Delivery" | "Collection";
  food: number;
  deliveryFee: number;
  tip: number;
  customerPaid: number;
  commission: number;
  adRecovered: number;
  toShop: number;
}

export interface EflStatementSummary {
  listingId: string;
  locationId: string;
  shopName: string;
  /** The week's Monday, "2026-10-26". */
  week: string;
  /** "26 Oct – 1 Nov 2026" */
  weekLabel: string;
  orders: number;
  customerPaid: number;
  food: number;
  deliveryFees: number;
  tips: number;
  commission: number;
  ads: { shows: number; taps: number; spent: number; ordersFromAds: number; recovered: number; stillOwed: number };
  toShop: number;
  refundedOrders: number;
}

export interface EflStatement extends EflStatementSummary {
  lines: EflStatementLine[];
}

export interface EflAdminStatementWeek {
  week: string;
  weekLabel: string;
  shops: EflStatementSummary[];
  totals: { orders: number; customerPaid: number; commission: number; adSpent: number; adRecovered: number; toShops: number };
}

export type EflCampaignChannel = "PUSH" | "EMAIL";

export interface EflCampaign {
  id: string;
  channel: EflCampaignChannel;
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  status: "DRAFT" | "SENDING" | "SENT" | "FAILED";
  targeted: number;
  delivered: number;
  sentAt: string | null;
  createdAt: string;
}

export interface EflCampaignInput {
  channel: EflCampaignChannel;
  title: string;
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
}

/** Saves a PDF the API returned as a file download. */
async function downloadPdf(url: string, filename: string) {
  const res = await apiClient.get<Blob>(url, { responseType: "blob" });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
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

  ads: (locationId: string) => apiClient.get<EflShopAds>(`/v1/efl/listing/${locationId}/ads`).then((r) => r.data),

  saveAds: (locationId: string, patch: Partial<Pick<EflAdCampaign, "active" | "weeklyBudget" | "maxBid">>) =>
    apiClient.put<EflAdCampaign>(`/v1/efl/listing/${locationId}/ads`, patch).then((r) => r.data),

  statements: (locationId: string) =>
    apiClient
      .get<{ recipient: string | null; weeks: EflStatementSummary[] }>(`/v1/efl/listing/${locationId}/statements`)
      .then((r) => r.data),

  statement: (locationId: string, week: string) =>
    apiClient.get<EflStatement>(`/v1/efl/listing/${locationId}/statements/${week}`).then((r) => r.data),

  downloadStatement: (locationId: string, week: string) =>
    downloadPdf(`/v1/efl/listing/${locationId}/statements/${week}/pdf`, `eat-for-less-${week}.pdf`),

  emailStatement: (locationId: string, week: string, to?: string) =>
    apiClient
      .post<{ sentTo: string }>(`/v1/efl/listing/${locationId}/statements/${week}/email`, to ? { to } : {})
      .then((r) => r.data),
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

  ads: () => apiClient.get<EflAdminAdRow[]>("/v1/admin/efl/ads").then((r) => r.data),

  pauseAds: (listingId: string, paused: boolean) =>
    apiClient.patch<EflAdCampaign>(`/v1/admin/efl/ads/${listingId}`, { paused }).then((r) => r.data),

  /** One week of every shop's statement; no week = last week. */
  statements: (week?: string) =>
    apiClient
      .get<EflAdminStatementWeek>("/v1/admin/efl/statements", { params: week ? { week } : {} })
      .then((r) => r.data),

  downloadStatement: (locationId: string, week: string) =>
    downloadPdf(`/v1/admin/efl/statements/${locationId}/${week}/pdf`, `eat-for-less-${week}.pdf`),

  sendStatements: (week: string) =>
    apiClient.post<{ sent: number }>("/v1/admin/efl/statements/send", { week }).then((r) => r.data),

  campaigns: () =>
    apiClient
      .get<{ campaigns: EflCampaign[]; audience: { push: number; email: number } }>("/v1/admin/efl/campaigns")
      .then((r) => r.data),

  createCampaign: (input: EflCampaignInput) =>
    apiClient.post<EflCampaign>("/v1/admin/efl/campaigns", input).then((r) => r.data),

  updateCampaign: (id: string, input: EflCampaignInput) =>
    apiClient.put<EflCampaign>(`/v1/admin/efl/campaigns/${id}`, input).then((r) => r.data),

  deleteCampaign: (id: string) => apiClient.delete(`/v1/admin/efl/campaigns/${id}`).then((r) => r.data),

  testCampaign: (id: string, to: string) =>
    apiClient.post<{ sentTo: string }>(`/v1/admin/efl/campaigns/${id}/test`, { to }).then((r) => r.data),

  sendCampaign: (id: string) => apiClient.post<EflCampaign>(`/v1/admin/efl/campaigns/${id}/send`).then((r) => r.data),
};

// ── Public website (eatforless.co.uk) ──────────────────────────────────

/** GET /v1/efl/shops — one listing near the customer. */
export interface EflPublicShop {
  id: string;
  name: string;
  area: string | null;
  logoUrl: string | null;
  heroImageUrl: string | null;
  description: string | null;
  cuisines: string[];
  distanceMiles: number;
  isOpen: boolean;
  /** Published review average; null until the shop has reviews. */
  rating: { value: number; count: number } | null;
  delivery: {
    available: boolean;
    fee: number | null;
    minOrder: number | null;
    etaMinutes: { min: number; max: number } | null;
  };
  collection: { available: boolean; readyInMinutes: number | null };
}

export interface EflShopsQuery {
  lat: number;
  lng: number;
  postcode?: string;
}

type EflMoney = number | string;

export interface EflPublicMenuItem {
  id: string;
  name: string;
  description?: string | null;
  basePrice: EflMoney;
  imageUrl?: string | null;
  isAvailable?: boolean;
  visibleToCustomers?: boolean;
  outOfStock?: boolean;
  allergens?: string[];
  productSkus?: Array<{ name: string; price: number }>;
}

export interface EflPublicMenuCategory {
  id: string;
  name: string;
  items: Array<{ itemId: string; priceOverride?: EflMoney | null; item: EflPublicMenuItem }>;
}

/** The storefront payload the menu wraps — only the fields the site reads. */
export interface EflPublicStore {
  location: {
    id: string;
    name: string;
    addressLine1?: string | null;
    city?: string | null;
    postcode?: string | null;
    about?: string | null;
  };
  brand: { id: string; name: string; logoUrl?: string | null } | null;
  menu: {
    id: string;
    heroImage?: string | null;
    bannerImage?: string | null;
    categories: EflPublicMenuCategory[];
  } | null;
  isOpen: boolean;
  directConfig?: {
    deliveryPrepMinutes: number;
    collectionPrepMinutes: number;
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
  };
}

/** GET /v1/efl/shops/:listingId/menu */
export interface EflPublicShopMenu {
  listing: {
    id: string;
    heroImageUrl: string | null;
    logoUrl: string | null;
    description: string | null;
    cuisines: string[];
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
  };
  store: EflPublicStore;
}

export const eflPublicClient = {
  shops: ({ lat, lng, postcode }: EflShopsQuery) =>
    apiClient
      .get<EflPublicShop[]>("/v1/efl/shops", { params: { lat, lng, ...(postcode ? { postcode } : {}) } })
      .then((r) => r.data),

  menu: (listingId: string) =>
    apiClient
      .get<EflPublicShopMenu>(`/v1/efl/shops/${encodeURIComponent(listingId)}/menu`)
      .then((r) => r.data),
};
