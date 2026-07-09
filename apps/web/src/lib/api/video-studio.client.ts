import { apiClient } from "./client";

export interface VideoStatus {
  addonActive: boolean;
  includedMonthly: number;
  includedBalance: number;
  topupBalance: number;
  balance: number;
  providerReady: boolean;
  model: string;
  canTestActivate?: boolean;
}

export type VideoGenStatus = "QUEUED" | "RENDERING" | "READY" | "FAILED";

export interface VideoGeneration {
  id: string;
  status: VideoGenStatus;
  prompt: string;
  sourceImageUrl: string;
  resultUrl: string | null;
  error: string | null;
  creditsCost: number;
  createdAt: string;
}

export const videoStudioClient = {
  status: () => apiClient.get<VideoStatus>("/v1/video-studio").then((r) => r.data),
  generate: (body: {
    imageUrl: string;
    prompt: string;
    locationId?: string;
    brandId?: string;
  }) =>
    apiClient
      .post<VideoGeneration>("/v1/video-studio/generate", body)
      .then((r) => r.data),
  list: () =>
    apiClient
      .get<VideoGeneration[]>("/v1/video-studio/generations")
      .then((r) => r.data),
  get: (id: string) =>
    apiClient
      .get<VideoGeneration>(`/v1/video-studio/generations/${id}`)
      .then((r) => r.data),
  // Admin/testing hooks (replaced by Stripe in Phase 2).
  adminActivate: (includedMonthly = 15) =>
    apiClient
      .post("/v1/video-studio/admin/activate", { includedMonthly })
      .then((r) => r.data),
  adminTopup: (credits = 10) =>
    apiClient
      .post("/v1/video-studio/admin/topup", { credits })
      .then((r) => r.data),
};
