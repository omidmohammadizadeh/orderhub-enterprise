import { apiClient } from "./client";

export type AutoPublishChannel = "JUST_EAT" | "DELIVEROO" | "UBER_EATS" | "HUBRISE";

export interface AutoPublishSchedule {
  id: string;
  menuId: string;
  enabled: boolean;
  channels: AutoPublishChannel[];
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** "HH:mm" */
  times: string[];
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "partial" | "failed" | null;
  lastResult: AutoPublishRunResult[] | null;
}

export interface AutoPublishRunResult {
  channel: AutoPublishChannel;
  locationId: string | null;
  locationName: string | null;
  ok: boolean;
  message: string;
}

export interface AutoPublishState {
  schedule: AutoPublishSchedule | null;
  defaultTimezone: string;
  targets: Record<AutoPublishChannel, Array<{ locationId: string | null; locationName: string | null }>>;
}

export const menuAutoPublishClient = {
  get: (menuId: string) =>
    apiClient.get<AutoPublishState>(`/v1/menus/${menuId}/auto-publish`).then((r) => r.data),
  save: (
    menuId: string,
    body: Pick<AutoPublishSchedule, "enabled" | "channels" | "days" | "times" | "timezone">,
  ) => apiClient.put<AutoPublishSchedule>(`/v1/menus/${menuId}/auto-publish`, body).then((r) => r.data),
  remove: (menuId: string) => apiClient.delete(`/v1/menus/${menuId}/auto-publish`).then((r) => r.data),
  runNow: (menuId: string) =>
    apiClient
      .post<{ status: string; results: AutoPublishRunResult[]; ranAt: string }>(
        `/v1/menus/${menuId}/auto-publish/run`,
        {},
        { timeout: 180_000 },
      )
      .then((r) => r.data),
};
