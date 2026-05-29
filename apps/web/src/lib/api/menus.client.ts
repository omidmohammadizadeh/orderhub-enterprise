"use client";
import { apiClient } from "./client";

export interface Menu {
  id: string;
  brandId: string;
  name: string;
  description?: string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  isActive: boolean;
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
        isAvailable?: boolean;
        visibleToCustomers?: boolean;
      }>;
    };
  }>;
}

export interface MenuWithCategories extends Menu {
  categories: MenuCategory[];
}

export const menusClient = {
  listMenus: (brandId: string) =>
    apiClient.get<Menu[]>(`/v1/brands/${brandId}/menus`).then((r) => r.data),

  getMenu: (menuId: string) =>
    apiClient.get<MenuWithCategories>(`/v1/menus/${menuId}`).then((r) => r.data),

  createMenu: (brandId: string, data: { name: string; description?: string }) =>
    apiClient.post<Menu>(`/v1/brands/${brandId}/menus`, data).then((r) => r.data),

  updateMenu: (menuId: string, data: Partial<{ name: string; description: string; status: string; isActive: boolean }>) =>
    apiClient.patch<Menu>(`/v1/menus/${menuId}`, data).then((r) => r.data),

  publishMenu: (menuId: string) =>
    apiClient.post<Menu>(`/v1/menus/${menuId}/publish`, {}).then((r) => r.data),

  archiveMenu: (menuId: string) =>
    apiClient.post<Menu>(`/v1/menus/${menuId}/archive`, {}).then((r) => r.data),

  cloneMenu: (menuId: string, name: string) =>
    apiClient.post<MenuWithCategories>(`/v1/menus/${menuId}/clone`, { name }).then((r) => r.data),

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
