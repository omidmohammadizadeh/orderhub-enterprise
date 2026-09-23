import { apiClient } from "./client";

export interface VideoStyle {
  id: string;
  label: string;
  kind: "video" | "image";
  audio: boolean;
  needsScript: boolean;
  supportsFormat?: boolean;
  imageOptional?: boolean;
}

export interface VideoStatus {
  addonActive: boolean;
  /** The location whose wallet pays for renders here. */
  locationId: string | null;
  /** That wallet's balance, in pennies. */
  balanceMinor: number;
  currency: string;
  /** Price of each style for THIS location, in pennies. */
  pricesMinor: Record<string, number>;
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
  /** Pennies taken from the wallet. Older rows (credit era) have null. */
  chargedMinor?: number | null;
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

  // locationId decides WHICH wallet is quoted and billed — the balance and
  // prices returned belong to that location, and the API refuses one the user
  // has no access to.
  status: (locationId?: string | null) =>
    apiClient
      .get<VideoStatus>("/v1/video-studio", {
        params: locationId ? { locationId } : {},
      })
      .then((r) => r.data),
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
};
