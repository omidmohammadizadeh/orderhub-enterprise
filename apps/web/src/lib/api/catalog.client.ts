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
    priceOverrides?: Record<string, number>;
  }>;
  deliveryTax: string | number;
  takeawayTax: string | number;
  eatInTax: string | number;
  dietaryTags: string[];
  allergens: string[];
  menuIds: string[];
  // Brands this product belongs to (multi-brand / dark kitchen). Drives
  // HubRise per-brand variant restrictions on publish.
  brandIds?: string[];
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
  // Per-variant price overrides keyed by pricing-variant ref.
  platformPricingOverrides?: Record<string, number>;
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
  // Phase AP — Products tab is location-scoped. The brand list above
  // is kept for the menu editor's "Add from catalog" picker, which
  // still cross-references the full brand library.
  listForLocation: (locationId: string) =>
    apiClient
      .get<CatalogProduct[]>(`/v1/locations/${locationId}/items`)
      .then((r) => r.data),
  // Phase AW-12 — single-item read for the product editor. Direct
  // by-id lookup avoids the brand-list-then-find pattern that broke
  // edit hydration when menu.brandId drifted from item.brandId.
  get: (id: string) =>
    apiClient.get<CatalogProduct>(`/v1/items/${id}`).then((r) => r.data),
  create: (brandId: string, data: Partial<CatalogProduct> & { locationId?: string }) =>
    apiClient
      .post<CatalogProduct>(`/v1/brands/${brandId}/items`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogProduct>) =>
    apiClient.patch<CatalogProduct>(`/v1/items/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/items/${id}`).then((r) => r.data),
  // The menus controller exposes /v1/items/:itemId/... — these three
  // endpoints were lagging on the old /v1/menu-items/ prefix, which
  // 404'd every save that attached a modifier group. The attach
  // endpoint also expects the groupId in the URL, not the body.
  toggleAvailability: (id: string) =>
    apiClient
      .post<CatalogProduct>(`/v1/items/${id}/toggle-availability`)
      .then((r) => r.data),
  attachModifierGroup: (itemId: string, groupId: string) =>
    apiClient
      .post(`/v1/items/${itemId}/modifier-groups/${groupId}`)
      .then((r) => r.data),
  detachModifierGroup: (itemId: string, groupId: string) =>
    apiClient
      .delete(`/v1/items/${itemId}/modifier-groups/${groupId}`)
      .then((r) => r.data),

  /**
   * Copy this item's modifier groups and/or size set onto other items.
   *
   * One request rather than a loop of attach calls: applying a group to
   * thirty items would otherwise be thirty round-trips, and a failure
   * halfway through would leave the menu half-applied with no way to tell
   * which half.
   */
  applyToItems: (
    itemId: string,
    body: {
      targetItemIds: string[];
      modifierGroupIds?: string[];
      includeSkus?: boolean;
    },
  ) =>
    apiClient
      .post<{
        itemsUpdated: number;
        modifierGroupLinksCreated: number;
        skusApplied: number;
      }>(`/v1/items/${itemId}/apply-to`, body)
      .then((r) => r.data),
};

// ── Modifier Groups ────────────────────────────────────────────────────────
export const modifierGroupsClient = {
  list: (brandId: string) =>
    apiClient
      .get<CatalogModifierGroup[]>(`/v1/brands/${brandId}/modifier-groups`)
      .then((r) => r.data),
  // Phase AW-18.2 — single-row read. Mirrors productsClient.get from
  // AW-12 so the edit form hydrates by id (brand-drift safe).
  get: (id: string) =>
    apiClient
      .get<CatalogModifierGroup>(`/v1/modifier-groups/${id}`)
      .then((r) => r.data),
  // Phase AP — Products tab is location-scoped.
  listForLocation: (locationId: string) =>
    apiClient
      .get<CatalogModifierGroup[]>(
        `/v1/locations/${locationId}/modifier-groups`,
      )
      .then((r) => r.data),
  create: (
    brandId: string,
    data: Partial<CatalogModifierGroup> & { locationId?: string },
  ) =>
    apiClient
      .post<CatalogModifierGroup>(`/v1/brands/${brandId}/modifier-groups`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogModifierGroup>) =>
    apiClient
      .patch<CatalogModifierGroup>(`/v1/modifier-groups/${id}`, data)
      .then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/modifier-groups/${id}`).then((r) => r.data),
  /** Deep copy — new group, new modifiers, all with fresh PLUs. */
  duplicate: (id: string) =>
    apiClient
      .post<CatalogModifierGroup>(`/v1/modifier-groups/${id}/duplicate`)
      .then((r) => r.data),
};

// ── Modifiers (ModifierOption) ─────────────────────────────────────────────
export const modifiersClient = {
  create: (groupId: string, data: Partial<CatalogModifier>) =>
    apiClient
      .post<CatalogModifier>(`/v1/modifier-groups/${groupId}/options`, data)
      .then((r) => r.data),
  // Phase AW-18.2 — single-row read for the edit form.
  get: (id: string) =>
    apiClient
      .get<CatalogModifier>(`/v1/modifier-options/${id}`)
      .then((r) => r.data),
  update: (id: string, data: Partial<CatalogModifier>) =>
    apiClient.patch<CatalogModifier>(`/v1/modifier-options/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/modifier-options/${id}`).then((r) => r.data),
  /** Copy into the same group with a fresh PLU. */
  duplicate: (id: string) =>
    apiClient
      .post<CatalogModifier>(`/v1/modifier-options/${id}/duplicate`)
      .then((r) => r.data),

  // Phase AL — attach/detach an existing modifier to/from a group.
  // Uses ModifierOption.modifierGroupIds[] under the hood; the
  // primary FK group is preserved.
  attachToGroup: (groupId: string, modifierId: string) =>
    apiClient
      .post(`/v1/modifier-groups/${groupId}/modifiers/${modifierId}`)
      .then((r) => r.data),
  detachFromGroup: (groupId: string, modifierId: string) =>
    apiClient
      .delete(`/v1/modifier-groups/${groupId}/modifiers/${modifierId}`)
      .then((r) => r.data),
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
  // Phase AP — location-scoped Products tab
  listForLocation: (locationId: string) =>
    apiClient
      .get<MealDeal[]>(`/v1/locations/${locationId}/meal-deals`)
      .then((r) => r.data),
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
  // Phase AP — location-scoped Products tab
  listForLocation: (locationId: string) =>
    apiClient
      .get<UpsellGroup[]>(`/v1/locations/${locationId}/upsell-groups`)
      .then((r) => r.data),
  create: (brandId: string, data: Partial<UpsellGroup>) =>
    apiClient
      .post<UpsellGroup>(`/v1/brands/${brandId}/upsell-groups`, data)
      .then((r) => r.data),
  update: (id: string, data: Partial<UpsellGroup>) =>
    apiClient.patch<UpsellGroup>(`/v1/upsell-groups/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/upsell-groups/${id}`).then((r) => r.data),
};

// ── Image upload (Phase AL — Supabase Storage) ─────────────────────────────
export const uploadsClient = {
  /**
   * Sends a resized image (data URL) to the API, which stores it in the
   * Supabase Storage bucket and returns the public https URL to save on the
   * product/modifier row. The uploader falls back to the data URL if this
   * fails (e.g. storage not configured yet).
   */
  uploadProductImage: (data: { dataUrl: string; folder?: string }) =>
    apiClient
      .post<{ publicUrl: string }>(`/v1/uploads/product-image`, data)
      .then((r) => r.data),
};
