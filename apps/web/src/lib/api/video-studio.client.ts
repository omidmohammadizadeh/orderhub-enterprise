import { apiClient } from "./client";

export interface VideoStyle {
  id: string;
  label: string;
  kind: "video" | "image";
  credits: number;
  audio: boolean;
  needsScript: boolean;
  supportsFormat?: boolean;
  imageOptional?: boolean;
}

export interface VideoStatus {
  addonActive: boolean;
  includedMonthly: number;
  includedBalance: number;
  topupBalance: number;
  balance: number;
  providerReady: boolean;
  providers?: { gemini: boolean; replicate: boolean };
  /** False when file storage is off — finished videos then keep a provider
   *  URL that expires within the hour. */
  storageReady?: boolean;
  model: string;
  styles?: VideoStyle[];
  canTestActivate?: boolean;
}

export type VideoGenStatus = "QUEUED" | "RENDERING" | "READY" | "FAILED";

export interface VideoGeneration {
  id: string;
  kind?: "VIDEO" | "IMAGE";
  status: VideoGenStatus;
  prompt: string;
  sourceImageUrl: string;
  resultUrl: string | null;
  error: string | null;
  creditsCost: number;
  createdAt: string;
}

export interface StorageCheck {
  bucket: string;
  video: { ok: boolean; stage: string; error?: string };
  image: { ok: boolean; stage: string; error?: string };
  likelyCause: string | null;
}

export const videoStudioClient = {
  storageCheck: () =>
    apiClient
      .get<StorageCheck>("/v1/video-studio/admin/storage-check")
      .then((r) => r.data),

  status: () => apiClient.get<VideoStatus>("/v1/video-studio").then((r) => r.data),
  generate: (body: {
    imageUrl?: string;
    prompt: string;
    style?: string;
    script?: string;
    format?: string;
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
  cancel: (id: string) =>
    apiClient
      .post<VideoGeneration>(`/v1/video-studio/generations/${id}/cancel`)
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
