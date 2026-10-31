import { apiClient } from "./client";

// Careem per-brand connect + store control.
//
// Careem have no id to paste and no sign-in to do: connecting registers this
// brand at this location with Careem, then their operations team maps the branch
// to an outlet by hand. Orders only start once that is done, the menu is live
// and someone turns them on.

export interface CareemCatalogState {
  menuId?: string;
  menuName?: string;
  requestId?: string;
  status?: "PROCESSING" | "COMPLETED" | "FAILED" | "SEND_FAILED" | string;
  message?: string;
  sentAt?: string;
  finishedAt?: string | null;
  stats?: { categories: number; items: number; groups: number; options: number };
}

export interface CareemConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  environment: "staging" | "production";
  configured: boolean;
  branchId: string | null;
  registered: boolean;
  /** Registered on the other Careem environment, so it must be registered again. */
  wrongEnvironment: boolean;
  state: string | null;
  mapped: boolean;
  posIntegration: boolean;
  catalogOnBranch: boolean;
  catalog: CareemCatalogState | null;
  visibility: { status: string; reason: string | null; can_reactivate: boolean | null } | null;
  lastWebhookAt: string | null;
  lastError: string | null;
}

export interface CareemMenuProblem {
  entity: string;
  id: string;
  message: string;
}

export type CareemPublishResult =
  | { ok: true; requestId: string; stats?: CareemCatalogState["stats"] }
  | { ok: false; errors: CareemMenuProblem[] };

const base = "/v1/integrations/careem";

export const careemClient = {
  connect: (data: { brandId: string; locationId: string }) =>
    apiClient.post<CareemConnection>(`${base}/connect`, data).then((r) => r.data),
  health: (id: string) =>
    apiClient.get<CareemConnection>(`${base}/connections/${id}/health`).then((r) => r.data),
  setOrders: (id: string, active: boolean) =>
    apiClient.post<CareemConnection>(`${base}/connections/${id}/orders`, { active }).then((r) => r.data),
  pause: (id: string, minutes: number) =>
    apiClient.post<CareemConnection>(`${base}/connections/${id}/pause`, { minutes }).then((r) => r.data),
  resume: (id: string) =>
    apiClient.post<CareemConnection>(`${base}/connections/${id}/resume`).then((r) => r.data),
  publishHours: (id: string) =>
    apiClient.post(`${base}/connections/${id}/publish-hours`).then((r) => r.data),
  publishAssignedMenu: (id: string) =>
    apiClient.post<CareemPublishResult>(`${base}/connections/${id}/publish-menu`).then((r) => r.data),
  disconnect: (id: string) =>
    apiClient.post(`${base}/connections/${id}/disconnect`).then((r) => r.data),
  /** From Menus → Publish, where the operator has chosen the menu. */
  publishMenu: (menuId: string, data: { locationId?: string; brandId?: string }) =>
    apiClient.post<CareemPublishResult>(`${base}/menus/${menuId}/publish`, data).then((r) => r.data),
};
