// Email marketing — campaigns restaurants send to their own subscribed customers.

import type { EmailAudience, EmailDesign, EmailProduct } from "@orderhub/shared";
import { apiClient } from "./client";

export type EmailCampaignStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "CANCELLED" | "FAILED";
export type EmailContactStatus = "SUBSCRIBED" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED";

export interface EmailMarketingContext {
  enabled: boolean;
  live: boolean;
  pricePer1000Minor: number;
  freePerMonth: number;
  usedThisMonth: number;
  fromAddress: string | null;
  primaryColor: string | null;
  brands: { id: string; name: string; logoUrl: string | null; primaryLocationId: string | null }[];
}

export interface EmailContact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: EmailContactStatus;
  source: string | null;
  consentSource: string | null;
  consentAt: string | null;
  lastEmailedAt: string | null;
  lastOpenedAt: string | null;
  lastClickedAt: string | null;
  createdAt: string;
}

export interface EmailCampaignSummary {
  id: string;
  name: string;
  subject: string;
  status: EmailCampaignStatus;
  locationId: string | null;
  brandId: string | null;
  templateId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  openCount: number;
  clickCount: number;
  bounceCount: number;
  unsubscribeCount: number;
  chargedMinor: number;
  refundedMinor: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailCampaign extends EmailCampaignSummary {
  preheader: string | null;
  fromName: string | null;
  replyTo: string | null;
  design: EmailDesign;
  audience: EmailAudience;
  failedCount: number;
  skippedCount: number;
  complaintCount: number;
  freeUsed: number;
  results: { orders: number; revenue: number; currency: string };
}

export interface EmailEstimate {
  recipients: number;
  freeRemaining: number;
  free: number;
  billable: number;
  pricePer1000Minor: number;
  costMinor: number;
  balanceMinor: number;
  currency: string;
  canAfford: boolean;
  enabled: boolean;
}

export interface OfferCode {
  id: string;
  code: string;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
  value: number;
  minOrderValue: number | null;
  maxUses: number | null;
  usedCount: number;
  maxUsesPerCustomer: number | null;
  expiresAt: string | null;
}

export interface EmailImportReport {
  added: number;
  updated: number;
  duplicatesInFile: number;
  invalid: number;
  suppressed: number;
  total: number;
}

const BASE = "/v1/email-marketing";
const loc = (locationId?: string | null) => (locationId ? { locationId } : {});

export const emailMarketingClient = {
  /** With a shop selected, `brands` is just the brands that shop trades as,
   *  its own first. */
  context: (locationId?: string | null) =>
    apiClient.get<EmailMarketingContext>(`${BASE}/context`, { params: loc(locationId) }).then((r) => r.data),

  contacts: (params: {
    locationId?: string | null;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) =>
    apiClient
      .get<{ items: EmailContact[]; total: number; subscribed: number; byStatus: Record<string, number> }>(
        `${BASE}/contacts`,
        {
          params: {
            ...loc(params.locationId),
            ...(params.status ? { status: params.status } : {}),
            ...(params.search ? { search: params.search } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
            ...(params.offset ? { offset: params.offset } : {}),
          },
        },
      )
      .then((r) => r.data),

  sources: (locationId?: string | null) =>
    apiClient
      .get<{ source: string; count: number }[]>(`${BASE}/contacts/sources`, { params: loc(locationId) })
      .then((r) => r.data),

  addContact: (body: { email: string; firstName?: string; lastName?: string; locationId?: string | null }) =>
    apiClient.post(`${BASE}/contacts`, body).then((r) => r.data),

  importRows: (
    rows: { email: string; firstName?: string; lastName?: string; name?: string }[],
    locationId: string | null,
    assertConsent: boolean,
  ) =>
    apiClient
      .post<EmailImportReport>(`${BASE}/contacts/import-rows`, { rows, locationId, assertConsent })
      .then((r) => r.data),

  importFromOrders: (sources: string[], locationId: string | null, assertConsent: boolean) =>
    apiClient
      .post<EmailImportReport>(`${BASE}/contacts/import-from-orders`, { sources, locationId, assertConsent })
      .then((r) => r.data),

  unsubscribeContact: (id: string) =>
    apiClient.post(`${BASE}/contacts/${id}/unsubscribe`).then((r) => r.data),

  campaigns: (locationId?: string | null) =>
    apiClient
      .get<EmailCampaignSummary[]>(`${BASE}/campaigns`, { params: loc(locationId) })
      .then((r) => r.data),

  campaign: (id: string) => apiClient.get<EmailCampaign>(`${BASE}/campaigns/${id}`).then((r) => r.data),

  create: (body: { templateId: string; brandId?: string | null; locationId?: string | null; name?: string }) =>
    apiClient.post<EmailCampaign>(`${BASE}/campaigns`, body).then((r) => r.data),

  update: (id: string, body: Partial<Omit<EmailCampaign, "results">>) =>
    apiClient.patch<EmailCampaign>(`${BASE}/campaigns/${id}`, body).then((r) => r.data),

  duplicate: (id: string) =>
    apiClient.post<EmailCampaign>(`${BASE}/campaigns/${id}/duplicate`).then((r) => r.data),

  remove: (id: string) => apiClient.delete(`${BASE}/campaigns/${id}`).then((r) => r.data),

  test: (id: string, to: string[]) =>
    apiClient.post<{ ok: true; sentTo: string[] }>(`${BASE}/campaigns/${id}/test`, { to }).then((r) => r.data),

  send: (id: string) =>
    apiClient
      .post<{ ok: true; recipients: number; chargedMinor: number }>(`${BASE}/campaigns/${id}/send`)
      .then((r) => r.data),

  schedule: (id: string, at: string) =>
    apiClient.post<EmailCampaign>(`${BASE}/campaigns/${id}/schedule`, { at }).then((r) => r.data),

  cancel: (id: string) => apiClient.post(`${BASE}/campaigns/${id}/cancel`).then((r) => r.data),

  retry: (id: string) => apiClient.post<EmailCampaign>(`${BASE}/campaigns/${id}/retry`).then((r) => r.data),

  estimate: (body: { campaignId?: string; audience?: EmailAudience; locationId?: string | null }) =>
    apiClient.post<EmailEstimate>(`${BASE}/estimate`, body).then((r) => r.data),

  products: (params: { brandId?: string | null; locationId?: string | null; search?: string }) =>
    apiClient
      .get<EmailProduct[]>(`${BASE}/products`, {
        params: {
          ...(params.brandId ? { brandId: params.brandId } : {}),
          ...loc(params.locationId),
          ...(params.search ? { search: params.search } : {}),
        },
      })
      .then((r) => r.data),

  offerCodes: (locationId?: string | null) =>
    apiClient.get<OfferCode[]>(`${BASE}/promo-codes`, { params: loc(locationId) }).then((r) => r.data),

  createOfferCode: (body: {
    code: string;
    type: OfferCode["type"];
    value?: number;
    minOrderValue?: number | null;
    expiresAt?: string | null;
    maxUses?: number | null;
    oncePerCustomer?: boolean;
    locationId?: string | null;
  }) => apiClient.post<OfferCode>(`${BASE}/promo-codes`, body).then((r) => r.data),

  // Public — the unsubscribe page.
  unsubscribeInfo: (t: string) =>
    apiClient
      .get<{ valid: boolean; test?: boolean; brandName?: string; email?: string; status?: EmailContactStatus }>(
        `${BASE}/unsubscribe/info`,
        { params: { t } },
      )
      .then((r) => r.data),
  unsubscribe: (t: string) =>
    apiClient.post<{ ok: boolean }>(`${BASE}/unsubscribe`, { t }).then((r) => r.data),
  resubscribe: (t: string) =>
    apiClient.post<{ ok: boolean }>(`${BASE}/resubscribe`, { t }).then((r) => r.data),
};

export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const e = err as any;
  const m = e?.response?.data?.message;
  if (Array.isArray(m)) return m.join(", ");
  return m || e?.message || fallback;
}

export function formatMinor(minor: number, currency = "GBP"): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format((minor ?? 0) / 100);
  } catch {
    return `£${((minor ?? 0) / 100).toFixed(2)}`;
  }
}
