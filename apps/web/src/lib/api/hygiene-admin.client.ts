// Admin → Food hygiene. Per-location switch for the FSA hygiene badge on the
// storefront (and the restaurant apps, which show the storefront).

import { apiClient } from "./client";

export interface HygieneAdminRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  postcode: string | null;
  fsaId: string | null;
  rating: string | null;
  ratingDate: string | null;
  checkedAt: string | null;
  showing: boolean;
}

export const hygieneAdminClient = {
  list: () => apiClient.get<HygieneAdminRow[]>("/v1/admin/hygiene").then((r) => r.data),

  setEnabled: (locationId: string, enabled: boolean) =>
    apiClient.put<HygieneAdminRow>(`/v1/admin/hygiene/${locationId}`, { enabled }).then((r) => r.data),

  refresh: (locationId: string) =>
    apiClient.post<HygieneAdminRow>(`/v1/admin/hygiene/${locationId}/refresh`).then((r) => r.data),

  linkAll: () =>
    apiClient.post<{ linked: number; notFound: number }>("/v1/admin/hygiene/link-all").then((r) => r.data),
};
