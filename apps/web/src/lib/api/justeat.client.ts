import { apiClient } from "./client";

// Phase JE — Just Eat (JET Connect) per-brand connect + store control.
//
// Mirrors deliveroo.client. The one shape worth noting is `connect`: JET's own
// onboarding gives the operator a Restaurant ID and, for brands over six
// locations, their own Menu and Order API keys. Everyone else leaves the keys
// blank and falls through to the shared country keys.

export interface JustEatConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  posLocationId: string | null;
  restaurantReference: string | null;
  brandSlug: string | null;
  country: string | null;
  hasBrandKeys: boolean;
  lastWebhookAt: string | null;
  lastError: string | null;
}

export interface JustEatHealth extends JustEatConnection {
  menuKey: { configured: boolean; source: string };
  orderKey: { configured: boolean; source: string };
  webhookSignatureEnforced: boolean;
  inboundApiKeyEnforced: boolean;
  lastOrder: {
    id: string;
    displayId: string | null;
    createdAt: string;
    status: string;
  } | null;
}

export const justEatClient = {
  connect: (data: {
    brandId: string;
    locationId: string;
    restaurantReference: string;
    /** Defaults to the restaurant reference — only set when JET says otherwise. */
    posLocationId?: string;
    brandSlug?: string;
    country?: string;
    menuKey?: string;
    orderKey?: string;
  }) =>
    apiClient
      .post<JustEatConnection>("/v1/integrations/jet/connect", data)
      .then((r) => r.data),

  list: (brandId?: string) =>
    apiClient
      .get<JustEatConnection[]>("/v1/integrations/jet/connections", {
        params: brandId ? { brandId } : undefined,
      })
      .then((r) => r.data),

  health: (connectionId: string) =>
    apiClient
      .get<JustEatHealth>(`/v1/integrations/jet/${connectionId}/health`)
      .then((r) => r.data),

  disconnect: (connectionId: string) =>
    apiClient
      .post(`/v1/integrations/jet/${connectionId}/disconnect`, {})
      .then((r) => r.data),

  /** `onlineAt` is when to come back. Without it the shop stays off indefinitely. */
  pause: (connectionId: string, onlineAt?: string) =>
    apiClient
      .post<{ ok: boolean; online: boolean; restaurant: string }>(
        `/v1/integrations/jet/${connectionId}/pause`,
        onlineAt ? { onlineAt } : {},
      )
      .then((r) => r.data),

  resume: (connectionId: string) =>
    apiClient
      .post<{ ok: boolean; online: boolean; restaurant: string }>(
        `/v1/integrations/jet/${connectionId}/resume`,
        {},
      )
      .then((r) => r.data),

  publishHours: (connectionId: string) =>
    apiClient
      .post<{ ok: boolean; days: string[]; timezone: string; note?: string }>(
        `/v1/integrations/jet/${connectionId}/publish-hours`,
        {},
      )
      .then((r) => r.data),
};
