import { apiClient } from "./client";

// Digital Signage — menu boards on TV screens.

export interface SignageConfig {
  columns?: number;
  showImages?: boolean;
  showLogo?: boolean;
  pageRotationSeconds?: number;
  refreshSeconds?: number;
  theme?: string;
  /** Board background colour (hex, e.g. "#ffffff"). Overrides the light/dark
   *  theme default; text colour auto-adjusts for contrast. */
  background?: string;
  /** Optional explicit text colour (hex). Defaults to auto contrast. */
  text?: string;
  /** Physical screen rotation to match how the TV is mounted. */
  rotation?: 0 | 90 | 180 | 270;

  // ── Poster / promo images ─────────────────────────────────────────────
  /** What this screen shows. Defaults to MENU (the original behaviour). */
  mode?: "MENU" | "IMAGES" | "MIXED";
  /** Uploaded artwork (public https URLs), shown in this order. */
  images?: string[];
  /** Seconds each image holds. Default 10. */
  imageSeconds?: number;
  /** In MIXED, seconds the menu holds before the images run. Default 20. */
  menuSeconds?: number;
  /** contain = whole poster visible (default); cover = fill, may crop. */
  imageFit?: "contain" | "cover";
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
