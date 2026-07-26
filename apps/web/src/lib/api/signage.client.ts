import { apiClient } from "./client";

// Digital Signage — menu boards on TV screens.

export interface SignageConfig {
  columns?: number;
  showImages?: boolean;
  showLogo?: boolean;
  pageRotationSeconds?: number;
  refreshSeconds?: number;
  theme?: string;
}

export interface SignageDisplay {
  id: string;
  tenantId: string;
  locationId: string;
  brandId: string | null;
  name: string;
  publicToken: string;
  categoryIds: string[];
  orientation: "landscape" | "portrait";
  config: SignageConfig;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSignageInput {
  locationId: string;
  name: string;
  categoryIds?: string[];
  orientation?: "landscape" | "portrait";
  config?: SignageConfig;
  isActive?: boolean;
}

export const signageClient = {
  list: (locationId: string) =>
    apiClient
      .get<SignageDisplay[]>(`/v1/signage`, { params: { locationId } })
      .then((r) => r.data),

  create: (input: UpsertSignageInput) =>
    apiClient.post<SignageDisplay>(`/v1/signage`, input).then((r) => r.data),

  update: (id: string, input: Partial<UpsertSignageInput>) =>
    apiClient
      .patch<SignageDisplay>(`/v1/signage/${id}`, input)
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/v1/signage/${id}`).then((r) => r.data),
};

// ── Public TV render payload (consumed by /signage/[token]) ─────────────────

export interface SignageBoardItem {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  price?: number | null;
  sizes?: Array<{ name: string; price: number }>;
}

export interface SignageBoard {
  display: {
    name: string;
    orientation: "landscape" | "portrait";
    config: SignageConfig;
  };
  location: { name: string; logoUrl: string | null };
  categories: Array<{ id: string; name: string; items: SignageBoardItem[] }>;
}
