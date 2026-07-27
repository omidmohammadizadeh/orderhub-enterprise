import { apiClient } from "./client";

// Table Tabs (dine-in) — a location's physical tables and their open/free state.

export interface RestaurantTable {
  id: string;
  tenantId: string;
  locationId: string;
  name: string;
  seats: number | null;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "FREE" | "OCCUPIED";
  currentOrderId: string | null;
  openedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTableInput {
  locationId: string;
  name: string;
  seats?: number | null;
  area?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export const tablesClient = {
  list: (locationId: string) =>
    apiClient
      .get<RestaurantTable[]>(`/v1/tables`, { params: { locationId } })
      .then((r) => r.data),

  create: (input: UpsertTableInput) =>
    apiClient.post<RestaurantTable>(`/v1/tables`, input).then((r) => r.data),

  update: (id: string, input: Partial<UpsertTableInput>) =>
    apiClient
      .patch<RestaurantTable>(`/v1/tables/${id}`, input)
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/v1/tables/${id}`).then((r) => r.data),

  seat: (id: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/seat`, {})
      .then((r) => r.data),

  free: (id: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/free`, {})
      .then((r) => r.data),

  linkOrder: (id: string, orderId: string) =>
    apiClient
      .post<RestaurantTable>(`/v1/tables/${id}/link-order`, { orderId })
      .then((r) => r.data),
};
