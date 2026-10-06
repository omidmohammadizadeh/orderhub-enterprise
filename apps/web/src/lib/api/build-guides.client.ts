import { useQuery } from "@tanstack/react-query";
import { buildGuideNameKey, matchBuildGuideKey, type BuildGuideDto, type BuildGuideStep } from "@orderhub/shared";
import { apiClient } from "./client";

export type { BuildGuideDto, BuildGuideStep };

export interface BuildGuideOrderLine {
  orderItemId: string;
  name: string;
  quantity: number;
  modifiers: Array<{ name: string; quantity?: number; depth?: number }>;
  notes: string | null;
  guide: BuildGuideDto | null;
}

export interface BuildGuidePrintFeed {
  menuId: string | null;
  menuName: string | null;
  brandName: string | null;
  categories: Array<{
    name: string;
    items: Array<{ id: string; name: string; imageUrl: string | null; guide: BuildGuideDto }>;
  }>;
}

export interface BuildStepTemplate {
  id: string;
  brandId: string | null;
  title: string;
  text: string;
  imageUrl: string | null;
  amount: string | null;
  tools: string[];
  updatedAt: string;
}

export interface TrainingOverviewRow {
  id: string;
  name: string;
  brandName: string | null;
  stepCount: number;
  imageUrl: string | null;
  updatedAt: string;
  myStatus: "new" | "trained" | "refresher";
  trainedCount: number;
}

export interface TrainingGuide extends BuildGuideDto {
  brandName: string | null;
}

export const buildGuidesClient = {
  library: (q?: string) =>
    apiClient
      .get<BuildStepTemplate[]>("/v1/build-guides/library/steps", { params: q ? { q } : {} })
      .then((r) => r.data),
  saveToLibrary: (body: Partial<BuildStepTemplate> & { text: string }) =>
    apiClient.post<BuildStepTemplate>("/v1/build-guides/library/steps", body).then((r) => r.data),
  removeFromLibrary: (id: string) => apiClient.delete(`/v1/build-guides/library/steps/${id}`),
  aiDraft: (itemId: string) =>
    apiClient
      .post<{ steps: BuildGuideStep[]; packNote: string | null }>(`/v1/build-guides/item/${itemId}/ai-draft`, {}, { timeout: 120_000 })
      .then((r) => r.data),
  trainingOverview: () =>
    apiClient.get<TrainingOverviewRow[]>("/v1/build-guides/training/overview").then((r) => r.data),
  trainingGuide: (guideId: string) =>
    apiClient.get<TrainingGuide>(`/v1/build-guides/training/guide/${guideId}`).then((r) => r.data),
  completeTraining: (guideId: string) =>
    apiClient.post(`/v1/build-guides/training/guide/${guideId}/complete`, {}).then((r) => r.data),
  whoTrained: (guideId: string) =>
    apiClient
      .get<Array<{ name: string; completedAt: string; current: boolean }>>(
        `/v1/build-guides/training/guide/${guideId}/staff`,
      )
      .then((r) => r.data),
  printMenu: (menuId: string) =>
    apiClient.get<BuildGuidePrintFeed>(`/v1/build-guides/menu/${menuId}/print`).then((r) => r.data),
  printItem: (itemId: string) =>
    apiClient.get<BuildGuidePrintFeed>(`/v1/build-guides/item/${itemId}/print`).then((r) => r.data),
  getForItem: (itemId: string) =>
    apiClient
      .get<{ guide: BuildGuideDto | null }>(`/v1/build-guides/item/${itemId}`)
      .then((r) => r.data.guide),
  saveForItem: (itemId: string, body: { steps: BuildGuideStep[]; packNote: string | null }) =>
    apiClient
      .put<{ guide: BuildGuideDto | null }>(`/v1/build-guides/item/${itemId}`, body)
      .then((r) => r.data.guide),
  keys: () =>
    apiClient
      .get<Array<{ brandId: string; nameKey: string }>>("/v1/build-guides/keys")
      .then((r) => r.data),
  forOrder: (orderId: string) =>
    apiClient
      .get<{ orderId: string; lines: BuildGuideOrderLine[] }>(`/v1/build-guides/order/${orderId}`)
      .then((r) => r.data),
};

export const BUILD_GUIDE_KEYS_QUERY = ["build-guide-keys"] as const;

/**
 * Every product name in the tenant that has a guide. One small request,
 * shared by every order card / KDS ticket on the screen, so each can decide
 * whether to show "How to build" without asking the server per order.
 */
export function useBuildGuideKeys() {
  const q = useQuery({
    queryKey: BUILD_GUIDE_KEYS_QUERY,
    queryFn: buildGuidesClient.keys,
    staleTime: 60_000,
    // A failure here only hides a button — never retry-storm or surface it.
    retry: false,
  });
  const keys = new Set((q.data ?? []).map((k) => k.nameKey));
  return {
    keys,
    hasGuide: (name: string | null | undefined) =>
      keys.size > 0 && matchBuildGuideKey(name, keys) !== null,
  };
}

export { buildGuideNameKey };
