import { apiClient } from "./client";

export interface Review {
  id: string;
  rating: number;
  comment: string | null;
  customerName: string | null;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  // Dashboard-only fields (absent from the public projection).
  orderId?: string;
  locationId?: string;
  brandId?: string | null;
  status?: string;
}

export interface ReviewSummary {
  average: number;
  total: number;
  breakdown: Record<number, number>;
}

export const reviewsClient = {
  // ── Storefront (public, no auth) ───────────────────────────────────────
  submit: (body: {
    orderId: string;
    rating: number;
    comment?: string;
    customerName?: string;
  }) => apiClient.post<Review>("/v1/reviews/public", body).then((r) => r.data),

  publicList: (params: {
    brandId?: string;
    locationId?: string;
    rating?: number;
    limit?: number;
  }) =>
    apiClient
      .get<{ summary: ReviewSummary; reviews: Review[] }>("/v1/reviews/public", {
        params,
      })
      .then((r) => r.data),

  /** Which of these orders already have a review — drives the button state. */
  reviewed: (orderIds: string[]) =>
    apiClient
      .post<{ orderIds: string[] }>("/v1/reviews/public/reviewed", { orderIds })
      .then((r) => r.data.orderIds),

  // ── Dashboard ──────────────────────────────────────────────────────────
  list: (params?: {
    locationId?: string;
    brandId?: string;
    rating?: number;
    limit?: number;
  }) => apiClient.get<Review[]>("/v1/reviews", { params }).then((r) => r.data),

  reply: (id: string, reply: string) =>
    apiClient.patch<Review>(`/v1/reviews/${id}/reply`, { reply }).then((r) => r.data),

  setStatus: (id: string, status: "PUBLISHED" | "HIDDEN") =>
    apiClient.patch<Review>(`/v1/reviews/${id}/status`, { status }).then((r) => r.data),
};
