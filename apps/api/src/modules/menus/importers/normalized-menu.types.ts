// ── Normalized menu shape produced by each platform classifier ──────────────
//
// Every platform-specific importer (Uber, Deliveroo, HubRise, …) consumes
// the raw payload from the platform's API and produces a single normalized
// shape consumed by the menu writer. This isolates the writer from the
// quirks of each platform's API:
//
//   * Uber mixes products and modifiers in `items[]`, sets prices in pence.
//   * Deliveroo mixes products and modifiers in `menu.items[]` and labels
//     modifiers with `type: "CHOICE"`, modifier groups in `menu.modifiers[]`.
//   * HubRise prices come as "9.50 GBP" strings, modifiers under `option_lists`.
//
// All of those funnel into the same `NormalizedMenu` object below. The
// writer applies it to the database atomically (per-row upsert keyed on
// externalId + platformSource), respecting the import lock on the parent
// menu.

import type { ProductSku } from "@orderhub/shared";

export type PlatformSource = "uber" | "deliveroo" | "hubrise" | "justeat" | "ai";

/**
 * The whole normalized result of one import call.
 *
 * - `menuPatch` is the fields we want to merge onto the existing `Menu`
 *   row (e.g. menuData snapshot, lastSyncedAt). Never replaces categories
 *   or items — those live in their own arrays below.
 *
 * - `categories`, `products`, `modifierGroups`, `modifiers` are the
 *   per-row inserts/updates. Each carries the platform's external_id so
 *   the writer can find the matching local record.
 *
 * - `productModifierGroupLinks` and `modifierGroupModifierLinks` capture
 *   the cross-entity relations that we can only resolve AFTER all rows
 *   have local IDs. The writer applies them after the upsert pass.
 *
 * - `warnings` is non-fatal stuff the UI shows alongside a "success"
 *   import — empty modifier_ids on Deliveroo, missing PLU, etc.
 */
export interface NormalizedMenu {
  platformSource: PlatformSource;
  menuPatch: {
    menuData?: Record<string, unknown>;
    rawImportPayload: Record<string, unknown>;
    syncHash: string;
  };
  categories: NormalizedCategory[];
  products: NormalizedProduct[];
  modifierGroups: NormalizedModifierGroup[];
  modifiers: NormalizedModifier[];
  productModifierGroupLinks: Array<{
    productExternalId: string;
    modifierGroupExternalId: string;
  }>;
  modifierGroupModifierLinks: Array<{
    modifierGroupExternalId: string;
    modifierExternalId: string;
  }>;
  warnings: string[];
}

export interface NormalizedCategory {
  externalId: string;
  name: string;
  sortOrder: number;
  available: boolean;
  visibleToCustomers: boolean;
  syncHash: string;
  /** External item IDs belonging to this category — order matters. */
  productExternalIds: string[];
}

export interface NormalizedProduct {
  externalId: string;
  name: string;
  description?: string | null;
  /** Already in pounds (or whatever the tenant currency is). */
  price: number;
  imageUrl?: string | null;
  /** Platform's PLU or fallback to externalId. The PLU service may overwrite. */
  plu: string;
  isAvailable: boolean;
  outOfStock: boolean;
  visibleToCustomers: boolean;
  /** Multi-SKU pizza-style support — empty array for flat products. */
  hasMultipleSkus: boolean;
  productSkus: ProductSku[];
  /** External modifier-group IDs this product links to. Linked post-upsert. */
  modifierGroupExternalIds: string[];
  syncHash: string;
}

export interface NormalizedModifierGroup {
  externalId: string;
  name: string;
  plu: string;
  selectionType: "VARIANT" | "ADDON";
  minSelections: number;
  maxSelections: number;
  allowDuplicateSelections: boolean;
  /** External modifier (option) IDs in this group — order matters. */
  modifierExternalIds: string[];
  syncHash: string;
}

export interface NormalizedModifier {
  externalId: string;
  name: string;
  plu: string;
  /** Default price; pricesBySize overrides when matched. */
  priceAdjustment: number;
  pricesBySize: Record<string, number>;
  skuPlus: Record<string, string>;
  isAvailable: boolean;
  visibleToCustomers: boolean;
  syncHash: string;
}
