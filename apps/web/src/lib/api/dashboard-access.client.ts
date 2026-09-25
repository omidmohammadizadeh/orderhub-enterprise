import { apiClient } from "./client";

// Admin Dashboard → Dashboard access. PLATFORM_ADMIN only; the API enforces
// the role, this is just the transport.
//
// Reads for ORDINARY users don't come through here — the sidebar already
// holds the locations list, and `Location.settings.dashboardAccess` rides
// along with it. One fetch, no extra round trip on every dashboard page.

export interface DashboardAccessRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  disabledTabs: string[];
}

export const dashboardAccessClient = {
  list: () =>
    apiClient
      .get<DashboardAccessRow[]>("/v1/admin/dashboard-access")
      .then((r) => r.data),
  get: (locationId: string) =>
    apiClient
      .get<DashboardAccessRow>(`/v1/admin/dashboard-access/${locationId}`)
      .then((r) => r.data),
  set: (locationId: string, disabledTabs: string[]) =>
    apiClient
      .put<DashboardAccessRow>(`/v1/admin/dashboard-access/${locationId}`, {
        disabledTabs,
      })
      .then((r) => r.data),
};
