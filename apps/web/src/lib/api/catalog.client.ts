"use client";
// Master catalog API client. Wraps the existing menu endpoints (items,
// modifiers, modifier groups, variants) and the new meal-deals / upsell-
// groups endpoints into a single facade so the /dashboard/products tabs
// share a consistent client.

import { apiClient } from "./client";

// ── Shared types — mirror the Prisma row shapes used by the UI ─────────────
export interface CatalogProduct {
  id: string;
  brandId: string;
  name: string;
  description: string | null;
  basePrice: string | number;
  imageUrl: string | null;
  plu: string | null;
  sku: string | null;
  isAvailable: boolean;
  visibleToCustomers: boolean;
  outOfStock: boolean;
  hasMultipleSkus: boolean;
  productSkus: Array<{
    name: string;
    plu: string;
    price: number;
    modifierGroups: string[];
  }>;
  deliveryTax: string | number;
  takeawayTax: string | number;
  eatInTax: string | number;
  dietaryTags: string[];
  allergens: string[];
  menuIds: string[];
  platformPricingOverrides: Record<string, number>;
  modifierGroupLinks?: Array<{
    groupId: string;
    group: CatalogModifierGroup;
  }>;
  variants?: CatalogVariant[];
  createdAt: string;
  updatedAt: string;
}

export interface CatalogVariant {
  id: string;
  itemId: string;
  name: string;
  sku: string | null;
  price: string | number;
  sortOrder: number;
  isAvailable: boolean;
}

export interface CatalogModifierGroup {
  id: string;
  brandId: string;
  name: string;
  description: string | null;
  plu: string | null;
  selectionType: "VARIANT" | "ADDON";
  minSelections: number;
  maxSelections: number | null;
  isRequired: boolean;
  allowDuplicateSelections: boolean;
  visibleToCustomers: boolean;
  options?: CatalogModifier[];
  _count?: { itemLinks: number };
}

export interface CatalogModifier {
  id: string;
  groupId: string;
  name: string;
  description: string | null;
  plu: string | null;
  priceAdjustment: string | number;
  pricesBySize: Record<string, number>;
  skuPlus: Record<string, string>;
  imageUrl: string | null;
  isAvailable: boolean;
  isDefault: boolean;
  visibleToCustomers: boolean;
  sortOrder: number;
  deliveryTax: string | number;
  takeawayTax: string | number;
  eatInTax: string | number;
}

export interface MealDeal {
  id: string;
  brandId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  plu: string | null;
  price: string | number | null;
  sections: Array<{
    name: string;
    minChoices: number;
    maxChoices: number;
    options: Array<{ menuItemId: string; priceOverride?: number }>;
  }>;
  isAvailable: boolean;
  visibleToCustomers: boolean;
  locationIds: string[];
  platformPricingOverrides: Record<string, number>;
}

export interface UpsellGroup {
  id: string;
  brandId: string;
  name: string;
  description: string | null;
  triggerProductIds: string[];
  triggerCategoryIds: string[];
  suggestedProductIds: string[];
  sortOrder: number;
  platformVisibility: string[];
  isActive: boolean;
}

// ── Products (MenuItem) ────────────────────────────────────────────────────
export const productsClient = {
  list: (brandId: string) =>
    apiClient
      .get<CatalogProduct[]>(`/v1/brands/${brandId}/items`)
      .then((r) => r.data),
  create: (brandId: string, data: Partial<CatalogProduct>) =>
    apiClient
      .post<CatalogProduct>(`/v1/brands/${brandId}/items`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogProduct>) =>
    apiClient.patch<CatalogProduct>(`/v1/items/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/items/${id}`).then((r) => r.data),
  toggleAvailability: (id: string) =>
    apiClient
      .patch<CatalogProduct>(`/v1/menu-items/${id}/toggle-availability`)
      .then((r) => r.data),
  attachModifierGroup: (itemId: string, groupId: string) =>
    apiClient
      .post(`/v1/menu-items/${itemId}/modifier-groups`, { groupId })
      .then((r) => r.data),
  detachModifierGroup: (itemId: string, groupId: string) =>
    apiClient
      .delete(`/v1/menu-items/${itemId}/modifier-groups/${groupId}`)
      .then((r) => r.data),
};

// ── Modifier Groups ────────────────────────────────────────────────────────
export const modifierGroupsClient = {
  list: (brandId: string) =>
    apiClient
      .get<CatalogModifierGroup[]>(`/v1/brands/${brandId}/modifier-groups`)
      .then((r) => r.data),
  create: (brandId: string, data: Partial<CatalogModifierGroup>) =>
    apiClient
      .post<CatalogModifierGroup>(`/v1/brands/${brandId}/modifier-groups`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogModifierGroup>) =>
    apiClient
      .patch<CatalogModifierGroup>(`/v1/modifier-groups/${id}`, data)
      .then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/modifier-groups/${id}`).then((r) => r.data),
};

// ── Modifiers (ModifierOption) ─────────────────────────────────────────────
export const modifiersClient = {
  create: (groupId: string, data: Partial<CatalogModifier>) =>
    apiClient
      .post<CatalogModifier>(`/v1/modifier-groups/${groupId}/options`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogModifier>) =>
    apiClient.patch<CatalogModifier>(`/v1/modifier-options/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/modifier-options/${id}`).then((r) => r.data),
};

// ── Variants ──────────────────────────────────────────────────────────────
export const variantsClient = {
  create: (
    itemId: string,
    data: { name: string; price: number; sku?: string; sortOrder?: number },
  ) =>
    apiClient
      .post<CatalogVariant>(`/v1/items/${itemId}/variants`, data)
      .then((r) => r.data),
  update: (
    id: string,
    data: Partial<{
      name: string;
      price: number;
      sku: string;
      sortOrder: number;
      isAvailable: boolean;
    }>,
  ) =>
    apiClient.patch<CatalogVariant>(`/v1/items/variants/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/items/variants/${id}`).then((r) => r.data),
};

// ── Meal Deals (Phase AL — new) ────────────────────────────────────────────
export const mealDealsClient = {
  list: (brandId: string) =>
    apiClient.get<MealDeal[]>(`/v1/brands/${brandId}/meal-deals`).then((r) => r.data),
  create: (brandId: string, data: Partial<MealDeal>) =>
    apiClient
      .post<MealDeal>(`/v1/brands/${brandId}/meal-deals`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<MealDeal>) =>
    apiClient.patch<MealDeal>(`/v1/meal-deals/${id}`, data).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/v1/meal-deals/${id}`).then((r) => r.data),
};

// ── Upsell Groups (Phase AL — new) ─────────────────────────────────────────
export const upsellGroupsClient = {
  list: (brandId: string) =>
    apiClient.get<UpsellGroup[]>(`/v1/brands/${brandId}/upsell-groups`).then((r) => r.data),
  create: (brandId: string, data: Partial<UpsellGroup>) =>
    apiClient
      .post<UpsellGroup>(`/v1/brands/${brandId}/upsell-groups`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<UpsellGroup>) =>
    apiClient.patch<UpsellGroup>(`/v1/upsell-groups/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/upsell-groups/${id}`).then((r) => r.data),
};

// ── Image upload (Phase AL — Supabase Storage signed URLs) ─────────────────
export const uploadsClient = {
  /**
   * Asks the API for a signed upload URL pointing to the Supabase
   * Storage bucket. The client then PUTs the file to that URL directly —
   * no proxying through Render. Returns the public URL to save on the
   * product/modifier row.
   */
  signProductImage: (data: { fileName: string; contentType: string }) =>
    apiClient
      .post<{ uploadUrl: string; publicUrl: string; path: string; token: string }>(
        `/v1/uploads/product-image/sign`,
        data,
      )
      .then((r) => r.data),
};
