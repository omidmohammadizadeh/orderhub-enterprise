import { useQuery } from "@tanstack/react-query";
import { matchBuildGuideKey, type AssemblyChartDto, type AssemblyLayer } from "@orderhub/shared";
import { apiClient } from "./client";

export type { AssemblyChartDto, AssemblyLayer };

export interface ChartOrderLine {
  orderItemId: string;
  name: string;
  quantity: number;
  modifiers: Array<{ name: string; quantity?: number; depth?: number }>;
  notes: string | null;
  chart: AssemblyChartDto | null;
}

export interface ChartSaveBody {
  title: string;
  altTitle: string | null;
  heroImageUrl: string | null;
  footNote: string | null;
  layers: AssemblyLayer[];
}

export const assemblyChartsClient = {
  getForItem: (itemId: string) =>
    apiClient
      .get<{ chart: AssemblyChartDto | null; productImageUrl: string | null }>(`/v1/assembly-charts/item/${itemId}`)
      .then((r) => r.data),
  saveForItem: (itemId: string, body: ChartSaveBody) =>
    apiClient
      .put<{ chart: AssemblyChartDto | null }>(`/v1/assembly-charts/item/${itemId}`, body)
      .then((r) => r.data.chart),
  keys: () =>
    apiClient.get<Array<{ brandId: string; nameKey: string }>>("/v1/assembly-charts/keys").then((r) => r.data),
  all: () =>
    apiClient
      .get<Array<AssemblyChartDto & { brandName: string | null }>>("/v1/assembly-charts/all")
      .then((r) => r.data),
  forOrder: (orderId: string) =>
    apiClient
      .get<{ orderId: string; lines: ChartOrderLine[] }>(`/v1/assembly-charts/order/${orderId}`)
      .then((r) => r.data),
  printMenu: (menuId: string) =>
    apiClient
      .get<{ menuName: string; brandName: string | null; charts: AssemblyChartDto[] }>(
        `/v1/assembly-charts/menu/${menuId}/print`,
      )
      .then((r) => r.data),
};

export const CHART_KEYS_QUERY = ["assembly-chart-keys"] as const;

/** One small request decides every Chart button on the screen. */
export function useAssemblyChartKeys() {
  const q = useQuery({
    queryKey: CHART_KEYS_QUERY,
    queryFn: assemblyChartsClient.keys,
    staleTime: 60_000,
    retry: false,
  });
  const keys = new Set((q.data ?? []).map((k) => k.nameKey));
  return {
    hasChart: (name: string | null | undefined) => keys.size > 0 && matchBuildGuideKey(name, keys) !== null,
  };
}
