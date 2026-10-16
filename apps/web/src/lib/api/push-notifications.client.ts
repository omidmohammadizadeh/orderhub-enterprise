// Push notifications — order-stage pushes, the review ask, and campaigns to
// customers who said yes to offers. Browsers and the restaurant's own app
// share one audience.

import { apiClient } from "./client";

export type PushTrigger =
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "RIDER_ARRIVED"
  | "COMPLETED"
  | "CANCELLED"
  | "REVIEW_REQUEST";

export type PushCampaignStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";

export interface PushOverview {
  webConfigured: boolean;
  subscribers: { browsers: number; apps: number; offers: number };
  reviewsAskedLast30Days: number;
  brands: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export interface PushAutomation {
  trigger: PushTrigger;
  enabled: boolean;
  title: string | null;
  body: string | null;
  defaultTitle: string;
  defaultBody: string;
  delayMinutes: number | null;
  preview: { title: string; body: string } | null;
}

export interface PushCampaign {
  id: string;
  title: string;
  body: string;
  locationId: string | null;
  brandId: string | null;
  status: PushCampaignStatus;
  scheduledFor: string | null;
  sentAt: string | null;
  targeted: number;
  delivered: number;
  failed: number;
  createdAt: string;
}

export interface PushCampaignInput {
  title: string;
  body: string;
  locationId?: string | null;
  brandId?: string | null;
}

export const PUSH_TITLE_MAX = 65;
export const PUSH_BODY_MAX = 240;

const BASE = "/v1/push-notifications";

export const pushNotificationsClient = {
  overview: () => apiClient.get<PushOverview>(`${BASE}/overview`).then((r) => r.data),

  automations: () => apiClient.get<PushAutomation[]>(`${BASE}/automations`).then((r) => r.data),

  saveAutomation: (
    trigger: PushTrigger,
    body: { enabled: boolean; title: string | null; body: string | null; delayMinutes?: number | null },
  ) => apiClient.put<PushAutomation[]>(`${BASE}/automations/${trigger}`, body).then((r) => r.data),

  audience: (target: { locationId?: string | null; brandId?: string | null }) =>
    apiClient
      .get<{ total: number; browsers: number; apps: number }>(`${BASE}/audience`, {
        params: {
          ...(target.locationId ? { locationId: target.locationId } : {}),
          ...(target.brandId ? { brandId: target.brandId } : {}),
        },
      })
      .then((r) => r.data),

  campaigns: () => apiClient.get<PushCampaign[]>(`${BASE}/campaigns`).then((r) => r.data),

  createCampaign: (body: PushCampaignInput) =>
    apiClient.post<PushCampaign>(`${BASE}/campaigns`, body).then((r) => r.data),

  updateCampaign: (id: string, body: PushCampaignInput) =>
    apiClient.patch<PushCampaign>(`${BASE}/campaigns/${id}`, body).then((r) => r.data),

  sendCampaign: (id: string, scheduledFor?: string | null) =>
    apiClient.post<PushCampaign>(`${BASE}/campaigns/${id}/send`, { scheduledFor: scheduledFor ?? null }).then((r) => r.data),

  cancelCampaign: (id: string) =>
    apiClient.post<PushCampaign>(`${BASE}/campaigns/${id}/cancel`).then((r) => r.data),

  deleteCampaign: (id: string) => apiClient.delete(`${BASE}/campaigns/${id}`).then((r) => r.data),
};
