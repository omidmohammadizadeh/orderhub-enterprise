"use client";
import { apiClient } from "./client";
import type { PricingVariant } from "@orderhub/shared";

export type { PricingVariant } from "@orderhub/shared";

export interface Brand {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  isActive: boolean;
}

export const brandsClient = {
  list: () => apiClient.get<Brand[]>(`/v1/brands`).then((r) => r.data),
  create: (data: { name: string; slug: string }) =>
    apiClient.post<Brand>(`/v1/brands`, data).then((r) => r.data),
};

/** A menu at a location, with whether it's part of that location's single
 *  composed HubRise catalog. */
export interface HubRiseCatalogMenu {
  id: string;
  name: string;
  brandId: string;
  brandName: string | null;
  lastPublishedAt: string | null;
  productCount: number;
  inHubRiseCatalog: boolean;
}

export interface Menu {
  id: string;
  brandId: string;
  locationId?: string | null;
  name: string;
  description?: string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  isActive: boolean;
  /** Phase AM presentation fields, editable from the Settings drawer. */
  menuType?: string | null;
  bannerImage?: string | null;
  logoImage?: string | null;
  heroImage?: string | null;
  publishedTo?: string[];
  // Phase AW-11 — catalog import lifecycle on the menu row. Lets the UI
  // recover a slow import whose HTTP response was severed by a proxy
  // timeout: the import keeps running server-side and flips this to
  // SUCCESS/FAILED, so the client polls it instead of showing a false error.
  importStatus?: "IDLE" | "IMPORTING" | "SUCCESS" | "FAILED";
  // Phase BA — where this menu is currently SERVING. One row per
  // (location, channel, brand); source of truth for the Live-at badges
  // and the publish modal's pre-ticked locations.
  assignments?: Array<{
    locationId: string;
    channel: string;
    brandId: string;
    publishedAt: string;
  }>;
  // Phase AZ — named pricing variants (channel presets + custom) for
  // one-menu-controls-all per-channel/brand pricing.
  pricingVariants?: PricingVariant[];
  createdAt: string;
  updatedAt: string;
  _count?: { categories: number };
}

export interface MenuCategory {
  id: string;
  menuId: string;
  name: string;
  sortOrder: number;
  items: MenuItemOnCategory[];
}

export interface MenuItemOnCategory {
  categoryId: string;
  itemId: string;
  sortOrder: number;
  priceOverride?: number | null;
  item: MenuItem;
}

export interface ModifierOption {
  name: string;
  priceAdjustment: number;
  isDefault?: boolean;
  isAvailable?: boolean;
  sku?: string;
}

export interface ModifierGroup {
  name: string;
  description?: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  allowMultiple?: boolean;
  options: ModifierOption[];
}

// Phase AK — Base44-style SKU + per-size pricing types.
export interface ProductSku {
  name: string;
  plu: string;
  price: number;
  modifierGroups: string[];
  // Per-variant price overrides for this size, keyed by variant ref.
  priceOverrides?: Record<string, number>;
}

export interface MenuItem {
  id: string;
  brandId: string;
  name: string;
  description?: string | null;
  basePrice: number;
  imageUrl?: string | null;
  sku?: string | null;
  plu?: string | null;
  isAvailable: boolean;
  modifierGroups: ModifierGroup[];
  allergens: string[];
  calories?: number | null;
  // Phase AK fields
  visibleToCustomers?: boolean;
  outOfStock?: boolean;
  hasMultipleSkus?: boolean;
  productSkus?: ProductSku[];
  deliveryTax?: number;
  takeawayTax?: number;
  eatInTax?: number;
  dietary?: unknown[];
  menuIds?: string[];
  modifierGroupLinks?: Array<{
    itemId: string;
    groupId: string;
    sortOrder: number;
    group: {
      id: string;
      name: string;
      selectionType?: "VARIANT" | "ADDON";
      minSelections?: number;
      maxSelections?: number | null;
      allowDuplicateSelections?: boolean;
      options: Array<{
        id: string;
        name: string;
        priceAdjustment: number | string;
        plu?: string | null;
        pricesBySize?: Record<string, number> | null;
        skuPlus?: Record<string, string> | null;
        platformPricingOverrides?: Record<string, number> | null;
        isAvailable?: boolean;
        visibleToCustomers?: boolean;
      }>;
    };
  }>;
}

export interface MenuWithCategories extends Menu {
  categories: MenuCategory[];
}

// ── AI menu import (upload a PDF/photo, AI builds the menu) ─────────────────

export interface AiMenuSize {
  name: string;
  price: number;
  sku?: string | null;
}
export interface AiMenuOptionSizePrice {
  sizeName: string;
  price: number;
}
export interface AiMenuOption {
  name: string;
  priceAdjustment?: number;
  pricesBySize?: AiMenuOptionSizePrice[];
}
export interface AiMenuGroup {
  key: string;
  name: string;
  selectionType: "VARIANT" | "ADDON";
  minSelections?: number;
  maxSelections?: number;
  options: AiMenuOption[];
}
export interface AiMenuItem {
  name: string;
  description?: string | null;
  price?: number;
  sku?: string | null;
  sizes?: AiMenuSize[];
  modifierGroupKeys?: string[];
}
export interface AiMenuCategory {
  name: string;
  description?: string | null;
  items: AiMenuItem[];
}
export interface AiMenuDraft {
  menuName?: string;
  currency?: string;
  categories: AiMenuCategory[];
  modifierGroups?: AiMenuGroup[];
  warnings?: string[];
}

/** A file to send for parsing — `data` is base64 or a `data:` URL. */
export interface AiMenuFile {
  mediaType?: string;
  data: string;
}

export interface AiMenuCommitResult {
  menuId: string;
  menuName: string;
  createdCount: number;
  updatedCount: number;
  staleCount: number;
  warnings: string[];
  unchanged?: boolean;
}

export const menusClient = {
  listMenus: (brandId: string) =>
    apiClient.get<Menu[]>(`/v1/brands/${brandId}/menus`).then((r) => r.data),

  // Phase AP — Menu tab now scopes by the currently selected location
  // instead of leaking every menu under the brand.
  listMenusForLocation: (locationId: string) =>
    apiClient
      .get<Menu[]>(`/v1/locations/${locationId}/menus`)
      .then((r) => r.data),
  // Phase AW-18 — "All locations" view on the Menu tab. Tenant-wide
  // list, server filters by the caller's UserLocation set.
  listMenusForTenant: () =>
    apiClient.get<Menu[]>(`/v1/menus`).then((r) => r.data),

  getMenu: (menuId: string) =>
    apiClient.get<MenuWithCategories>(`/v1/menus/${menuId}`).then((r) => r.data),

  /**
   * One percentage uplift per channel, applied to every price in a menu.
   * Stored as per-channel overrides — base prices are never touched, so POS
   * and the operator's own site keep charging the real price.
   */
  /**
   * Photograph a menu, or one category of it. Returns a jobId immediately —
   * the work is throttled server-side and takes minutes, not seconds.
   */
  generateMenuImages: (body: {
    menuId: string;
    categoryId?: string;
    styleHint?: string;
    onlyMissing?: boolean;
    /** "premium" for the dark-slate look; omit for the plain template. */
    style?: string;
  }) =>
    apiClient
      .post<{ jobId?: string; error?: string }>("/v1/agent/menu-images", body)
      .then((r) => r.data),

  /**
   * Generate a 1920x1080 storefront banner from the menu's real dishes.
   * Returns a jobId — a wide high-quality render outlives the proxy timeout.
   */
  generateMenuBanner: (body: { menuId: string; brief?: string }) =>
    apiClient
      .post<{ jobId?: string; error?: string }>("/v1/agent/menu-banner", body)
      .then((r) => r.data),

  getMenuBannerJob: (jobId: string) =>
    apiClient
      .get<{
        status: "running" | "done" | "failed" | "unknown";
        url?: string;
        error?: string;
        basedOn?: string[];
      }>(`/v1/agent/menu-banner/${jobId}`)
      .then((r) => r.data),

  getMenuImageJob: (jobId: string) =>
    apiClient
      .get<{ status: string; total: number; done: number; failed: number }>(
        `/v1/agent/menu-images/${jobId}`,
      )
      .then((r) => r.data),

  applyChannelPricing: (
    menuId: string,
    body: {
      brandId: string;
      channels: Array<{ channelKey: string; name?: string; percent: number }>;
    },
  ) =>
    apiClient
      .post<{
        itemsUpdated: number;
        skusUpdated: number;
        optionsUpdated: number;
      }>(`/v1/menus/${menuId}/channel-pricing`, body)
      .then((r) => r.data),

  createMenu: (
    brandId: string,
    data: {
      name: string;
      description?: string;
      // Phase AP — when present, the new menu is stamped with this
      // locationId so it appears under that location in the Menu tab.
      locationId?: string;
      menuType?: string;
      bannerImage?: string;
      logoImage?: string;
      heroImage?: string;
    },
  ) =>
    apiClient
      .post<Menu>(`/v1/brands/${brandId}/menus`, data)
      .then((r) => r.data),

  // AI menu import — step 1: parse the uploaded files into a reviewable draft.
  // AI menu import — step 1. Parsing runs as a BACKGROUND JOB on the API
  // (large menus take >60s, which used to trip the proxy timeout and show a
  // bogus 500 even though the parse succeeded). Start the job, then poll
  // every 2.5s until it finishes — the same Promise<AiMenuDraft> shape as
  // before, so callers don't change.
  aiParseMenu: async (brandId: string, files: AiMenuFile[]) => {
    const { jobId } = (
      await apiClient.post<{ jobId: string }>(
        `/v1/brands/${brandId}/menus/import/ai/parse`,
        { files },
      )
    ).data;
    const startedAt = Date.now();
    const MAX_WAIT_MS = 8 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error("Reading the menu took too long — please try again.");
      }
      const job = (
        await apiClient.get<{
          status: "pending" | "done" | "failed";
          draft?: AiMenuDraft;
          error?: string;
        }>(`/v1/brands/${brandId}/menus/import/ai/parse/${jobId}`)
      ).data;
      if (job.status === "done" && job.draft) return job.draft;
      if (job.status === "failed") {
        throw new Error(job.error ?? "Couldn't read this menu.");
      }
    }
  },

  // AI menu import — step 2: create the menu from the reviewed draft.
  aiCommitMenu: (
    brandId: string,
    body: {
      menuName?: string;
      menuType?: string;
      locationId?: string;
      draft: AiMenuDraft;
    },
  ) =>
    apiClient
      .post<AiMenuCommitResult>(`/v1/brands/${brandId}/menus/import/ai/commit`, body)
      .then((r) => r.data),

  updateMenu: (
    menuId: string,
    data: Partial<{
      name: string;
      description: string;
      status: string;
      isActive: boolean;
      // Phase AP — editable from the menu editor "Settings" panel.
      menuType: string;
      bannerImage: string | null;
      logoImage: string | null;
      heroImage: string | null;
      locationId: string;
      // Phase BA — the locations this menu should SERVE (multi-select in
      // the publish modal). Sent with publishedTo; the API rewrites the
      // selected locations' serving assignments transactionally.
      locationIds: string[];
      publishedTo: string[];
      // Phase AW — re-assign the menu to a brand at publish time so
      // the channel + brand picker can move a draft menu under a
      // different virtual brand without making the operator delete
      // and re-create it.
      brandId: string;
      // Phase AZ — named pricing variants.
      pricingVariants: PricingVariant[];
    }>,
  ) => apiClient.patch<Menu>(`/v1/menus/${menuId}`, data).then((r) => r.data),

  publishMenu: (menuId: string) =>
    apiClient.post<Menu>(`/v1/menus/${menuId}/publish`, {}).then((r) => r.data),

  // Phase AW-11 — HubRise catalog hooks.
  importFromHubRise: (
    brandId: string,
    body: { locationId: string; catalogId?: string },
  ) =>
    apiClient
      .post<{ menuId: string; counts: Record<string, number> }>(
        `/v1/brands/${brandId}/menus/import/hubrise`,
        body,
      )
      .then((r) => r.data),

  publishToHubRise: (menuId: string) =>
    apiClient
      .post<{ catalogId: string; created: boolean }>(
        `/v1/menus/${menuId}/publish/hubrise`,
        {},
      )
      .then((r) => r.data),

  importFromUberEats: (body: { brandId: string; locationId: string }) =>
    apiClient
      .post<{ id: string; name: string }>(
        `/v1/menus/import/ubereats`,
        body,
      )
      .then((r) => r.data),

  publishToUberEats: (
    menuId: string,
    body?: { locationId?: string; brandId?: string },
  ) =>
    apiClient
      .post<{ ok: boolean }>(`/v1/menus/${menuId}/publish/ubereats`, body ?? {})
      .then((r) => r.data),

  importFromDeliveroo: (body: { brandId: string; locationId: string }) =>
    apiClient
      .post<{ id: string; name: string }>(
        `/v1/menus/import/deliveroo`,
        body,
      )
      .then((r) => r.data),

  publishToDeliveroo: (
    menuId: string,
    // Phase BA — publish targets this location's Deliveroo store.
    body?: { locationId?: string },
  ) =>
    apiClient
      .post<{
        ok: boolean;
        categories: number;
        products: number;
        groups: number;
        options: number;
        warnings: string[];
      }>(`/v1/menus/${menuId}/publish/deliveroo`, body ?? {})
      .then((r) => r.data),

  // Phase JE-3 — direct Just Eat (JET Connect) publish. `pending: true` is the
  // honest answer: JET's 202 only means the structure parsed, and the real
  // ingest result arrives later on our menu-callback endpoint.
  publishToJustEat: (
    menuId: string,
    body?: { locationId?: string; serviceTypes?: ("DELIVERY" | "COLLECTION")[] },
  ) =>
    apiClient
      .post<{
        ok: boolean;
        pending: boolean;
        restaurant: string;
        menus: number;
        categories: number;
        items: number;
        portions: number;
        groups: number;
        options: number;
        warnings: string[];
      }>(`/v1/menus/${menuId}/publish/justeat`, body ?? {})
      .then((r) => r.data),

  archiveMenu: (menuId: string) =>
    apiClient.post<Menu>(`/v1/menus/${menuId}/archive`, {}).then((r) => r.data),

  // Bulk-tag every item in a menu to one brand (replaces existing brand tags).
  tagMenuBrand: (menuId: string, brandId: string) =>
    apiClient
      .post<{ updated: number }>(`/v1/menus/${menuId}/tag-brand`, { brandId })
      .then((r) => r.data),

  // Break an imported menu's products off HubRise's ids so they stop colliding
  // with another menu imported from the same catalog.
  detachFromImport: (menuId: string) =>
    apiClient
      .post<{ detached: number; skippedShared: number; alreadyIndependent: number }>(
        `/v1/menus/${menuId}/detach-from-import`,
      )
      .then((r) => r.data),

  cloneMenu: (menuId: string, name: string, targetLocationId?: string) =>
    apiClient
      .post<MenuWithCategories>(`/v1/menus/${menuId}/clone`, {
        name,
        targetLocationId,
      })
      .then((r) => r.data),

  // Phase BC — Master Menu: combine several existing menus at a location
  // (typically one per brand) into one new menu for a single HubRise
  // connection to publish.
  createMasterMenu: (
    locationId: string,
    data: { name: string; description?: string; sourceMenuIds: string[] },
  ) =>
    apiClient
      .post<Menu>(`/v1/locations/${locationId}/menus/master`, data)
      .then((r) => r.data),

  // HubRise composed catalog — the set of brand menus that make up this
  // location's single HubRise catalog. Publishing any member menu republishes
  // all of them together, so no brand ever drops out of the catalog.
  listHubRiseCatalogMenus: (locationId: string) =>
    apiClient
      .get<HubRiseCatalogMenu[]>(`/v1/locations/${locationId}/hubrise-catalog`)
      .then((r) => r.data),

  setHubRiseCatalogMenus: (locationId: string, menuIds: string[]) =>
    apiClient
      .put<HubRiseCatalogMenu[]>(`/v1/locations/${locationId}/hubrise-catalog`, {
        menuIds,
      })
      .then((r) => r.data),

  deleteMenu: (menuId: string) =>
    apiClient.delete(`/v1/menus/${menuId}`).then((r) => r.data),

  createCategory: (menuId: string, data: { name: string; sortOrder?: number }) =>
    apiClient.post<MenuCategory>(`/v1/menus/${menuId}/categories`, data).then((r) => r.data),

  updateCategory: (categoryId: string, data: { name?: string; sortOrder?: number }) =>
    apiClient.patch<MenuCategory>(`/v1/categories/${categoryId}`, data).then((r) => r.data),

  deleteCategory: (categoryId: string) =>
    apiClient.delete(`/v1/categories/${categoryId}`).then((r) => r.data),

  listItems: (brandId: string) =>
    apiClient.get<MenuItem[]>(`/v1/brands/${brandId}/items`).then((r) => r.data),

  createItem: (brandId: string, data: Omit<MenuItem, "id" | "brandId">) =>
    apiClient.post<MenuItem>(`/v1/brands/${brandId}/items`, data).then((r) => r.data),

  updateItem: (itemId: string, data: Partial<Omit<MenuItem, "id" | "brandId">>) =>
    apiClient.patch<MenuItem>(`/v1/items/${itemId}`, data).then((r) => r.data),

  toggleAvailability: (itemId: string) =>
    apiClient.post<MenuItem>(`/v1/items/${itemId}/toggle-availability`, {}).then((r) => r.data),

  deleteItem: (itemId: string) =>
    apiClient.delete(`/v1/items/${itemId}`).then((r) => r.data),

  addItemToCategory: (categoryId: string, data: { itemId: string; sortOrder?: number; priceOverride?: number }) =>
    apiClient.post(`/v1/categories/${categoryId}/items`, data).then((r) => r.data),

  removeItemFromCategory: (categoryId: string, itemId: string) =>
    apiClient.delete(`/v1/categories/${categoryId}/items/${itemId}`).then((r) => r.data),

  // Phase AM — drag-drop reorder targets for the menu editor.
  // categories/reorder takes { items: [{id, sortOrder}] } per the
  // existing ReorderDto on the API; items-in-category reorder takes
  // { order: [{itemId, sortOrder}] } via the patch endpoint.
  reorderCategories: (
    menuId: string,
    body: { items: { id: string; sortOrder: number }[] },
  ) =>
    apiClient
      .post(`/v1/menus/${menuId}/categories/reorder`, body)
      .then((r) => r.data),

  reorderItemsInCategory: (
    categoryId: string,
    order: { itemId: string; sortOrder: number }[],
  ) =>
    apiClient
      .patch(`/v1/categories/${categoryId}/items/reorder`, { order })
      .then((r) => r.data),

  // ── Phase AK: Imports + PLU + POS-friendly lookup ──────────────────────────

  generateMissingPlus: () =>
    apiClient
      .post<{ products: number; modifierGroups: number; modifiers: number }>(
        `/v1/menus/generate-missing-plus`,
        {},
      )
      .then((r) => r.data),

  importUber: (
    menuId: string,
    body: { payload?: unknown; storeId?: string; accessToken?: string },
  ) =>
    apiClient
      .post<{
        createdCount: number;
        updatedCount: number;
        warnings: string[];
        unchanged?: boolean;
      }>(`/v1/menus/${menuId}/import/uber`, body)
      .then((r) => r.data),

  importDeliveroo: (
    menuId: string,
    body: {
      payload?: unknown;
      storeId?: string;
      deliverooBrandId?: string;
      accessToken?: string;
    },
  ) =>
    apiClient
      .post<{
        createdCount: number;
        updatedCount: number;
        warnings: string[];
        unchanged?: boolean;
      }>(`/v1/menus/${menuId}/import/deliveroo`, body)
      .then((r) => r.data),

  getActiveMenuForLocation: (locationId: string) =>
    apiClient
      .get<MenuWithCategories | null>(
        `/v1/locations/${locationId}/active-menu`,
      )
      .then((r) => r.data),
};
