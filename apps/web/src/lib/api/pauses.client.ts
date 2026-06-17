// Phase AW-15 — Stop Taking Orders / Busy Mode client.

import { apiClient } from "./client";

export const CHANNELS = [
  "ONLINE",
  "POS",
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "WHATSAPP",
  "HUBRISE",
] as const;
export type PauseChannel = (typeof CHANNELS)[number];

export const DURATIONS = [
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "until_tomorrow",
  "until_further_notice",
] as const;
export type PauseDuration = (typeof DURATIONS)[number];

export type PauseMode = "paused" | "busy";

export interface PauseRow {
  id: string;
  locationId: string;
  brandId: string | null;
  channel: PauseChannel | null;
  mode: PauseMode;
  resumeAt: string | null;
  reason: string | null;
  extraPrepTime: number | null;
  pausedAt: string;
  pausedBy: string | null;
}

export const pausesClient = {
  list: (locationId: string) =>
    apiClient
      .get<PauseRow[]>(`/v1/pauses/location/${locationId}`)
      .then((r) => r.data),

  pause: (body: {
    locationId: string;
    brandId?: string;
    channel?: PauseChannel;
    mode: PauseMode;
    duration?: PauseDuration;
    customResumeAt?: string;
    reason?: string;
    extraPrepTime?: number;
  }) => apiClient.post<PauseRow>("/v1/pauses", body).then((r) => r.data),

  resume: (body: {
    rowId?: string;
    locationId?: string;
    brandId?: string;
    channel?: PauseChannel;
  }) => apiClient.post("/v1/pauses/resume", body).then((r) => r.data),
};
