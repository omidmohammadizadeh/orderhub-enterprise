// Admin → Website showcase. Which brands appear on the "Trusted by" wall of
// the marketing homepage. Platform-admin only, across every tenant.

import { apiClient } from "./client";

export interface ShowcaseAdminRow {
  brandId: string;
  brandName: string;
  tenantName: string;
  logoUrl: string | null;
  city: string | null;
  showcaseOnWebsite: boolean;
  showcaseOrder: number | null;
  ordersLast30d: number;
}

export const websiteShowcaseClient = {
  list: () =>
    apiClient
      .get<ShowcaseAdminRow[]>("/v1/admin/website-showcase")
      .then((r) => r.data),

  set: (brandId: string, showcaseOnWebsite: boolean, showcaseOrder?: number | null) =>
    apiClient
      .put<ShowcaseAdminRow>(`/v1/admin/website-showcase/${brandId}`, {
        showcaseOnWebsite,
        ...(showcaseOrder !== undefined && { showcaseOrder }),
      })
      .then((r) => r.data),

  featureLive: () =>
    apiClient
      .post<{ featured: number }>("/v1/admin/website-showcase/feature-live")
      .then((r) => r.data),
};
