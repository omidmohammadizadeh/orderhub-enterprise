// Marketing SMS — consented audience + broadcasts, billed from the wallet.

import { apiClient } from "./client";

export interface MarketingContact {
  id: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  source?: string | null;
  consentStatus: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
  consentAt?: string | null;
  lastCampaignAt?: string | null;
  createdAt: string;
}

export interface ImportReport {
  added: number;
  updated: number;
  duplicatesInFile: number;
  invalid: number;
  suppressed: number;
  total: number;
}

export interface ChannelCount {
  channel: string;
  count: number;
}

export interface AudiencePreview {
  recipients: number;
  segmentsPerMessage: number;
  totalSegments: number;
  costMinor: number;
  pricePerSegmentMinor: number;
  balanceMinor: number;
  canAfford: boolean;
  previewText: string;
  messageLength: number;
}

export interface SmsCampaign {
  id: string;
  name: string;
  senderHeader?: string | null;
  body: string;
  status: "DRAFT" | "SENDING" | "SENT" | "FAILED";
  audience: { sources?: string[]; tags?: string[] };
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  segments: number;
  costMinor: number;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface ImportRow {
  phone: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
}

export const marketingSmsClient = {
  channels: (locationId?: string | null) =>
    apiClient
      .get<ChannelCount[]>("/v1/marketing-sms/channels", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),

  contacts: (
    params: { consent?: string; source?: string; search?: string; limit?: number; locationId?: string | null } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.consent) q.set("consent", params.consent);
    if (params.source) q.set("source", params.source);
    if (params.search) q.set("search", params.search);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.locationId) q.set("locationId", params.locationId);
    return apiClient
      .get<{ items: MarketingContact[]; total: number; optedIn: number }>(
        `/v1/marketing-sms/contacts?${q.toString()}`,
      )
      .then((r) => r.data);
  },

  importFromCustomers: (sources: string[], consentedOnly: boolean, locationId?: string | null) =>
    apiClient
      .post<ImportReport>("/v1/marketing-sms/contacts/import-from-customers", {
        sources, consentedOnly, locationId: locationId ?? undefined,
      })
      .then((r) => r.data),

  importRows: (rows: ImportRow[], source: string, assertConsent: boolean, locationId?: string | null) =>
    apiClient
      .post<ImportReport>("/v1/marketing-sms/contacts/import-rows", {
        rows, source, assertConsent, locationId: locationId ?? undefined,
      })
      .then((r) => r.data),

  addContact: (body: { phone: string; firstName?: string; lastName?: string; locationId?: string | null }) =>
    apiClient.post("/v1/marketing-sms/contacts", body).then((r) => r.data),

  setConsent: (id: string, status: "OPTED_IN" | "OPTED_OUT") =>
    apiClient.patch(`/v1/marketing-sms/contacts/${id}/consent`, { status }).then((r) => r.data),

  campaigns: (locationId?: string | null) =>
    apiClient
      .get<SmsCampaign[]>("/v1/marketing-sms/campaigns", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),

  campaign: (id: string) =>
    apiClient.get<SmsCampaign>(`/v1/marketing-sms/campaigns/${id}`).then((r) => r.data),

  saveCampaign: (body: {
    id?: string; name: string; senderHeader?: string; body: string; audience?: any; locationId?: string | null;
  }) => apiClient.post<SmsCampaign>("/v1/marketing-sms/campaigns", body).then((r) => r.data),

  preview: (body: { senderHeader?: string; body: string; audience?: any; locationId?: string | null }) =>
    apiClient.post<AudiencePreview>("/v1/marketing-sms/preview", body).then((r) => r.data),

  testSend: (body: {
    phone: string;
    senderHeader?: string;
    body: string;
    locationId?: string | null;
  }) => apiClient.post("/v1/marketing-sms/test-send", body).then((r) => r.data),

  send: (id: string) =>
    apiClient
      .post<{ ok: true; recipients: number; estimatedCostMinor: number }>(
        `/v1/marketing-sms/campaigns/${id}/send`,
      )
      .then((r) => r.data),
};
