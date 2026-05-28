import { apiClient } from "./client";

// Minimal Location shape returned by GET /v1/locations. The full Location
// model has many more fields (delivery config, opening hours, etc.); we only
// type the bits the dashboard needs for the location switcher.
export interface LocationSummary {
  id: string;
  name: string;
  brandId: string;
  brandName?: string | null;
  isActive: boolean;
  shopCode?: string | null;
}

export const locationsClient = {
  list: () =>
    apiClient.get<LocationSummary[]>("/v1/locations").then((r) => r.data),
};
