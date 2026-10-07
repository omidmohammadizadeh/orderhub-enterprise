/**
 * Assembly charts — the poster-style "build stack" for one product: a column
 * of illustrated layers top to bottom (toasted bun, sauce, onions, patty…),
 * like the laminated Smash Bundle board on a kitchen wall. Keyed exactly like
 * build guides: brand + buildGuideNameKey(product name).
 */

import { ASSEMBLY_INGREDIENTS } from "./assembly-ingredients";

/**
 * Every valid layer kind — the ingredient library's keys (see
 * assembly-ingredients.ts). The first 18 originals keep their own drawings.
 */
export const ASSEMBLY_LAYER_KINDS: readonly string[] = ASSEMBLY_INGREDIENTS.map((i) => i.key);

/** An ingredient key from ASSEMBLY_INGREDIENTS (kept as string so the library can grow). */
export type AssemblyLayerKind = string;

export interface AssemblyLayer {
  id: string;
  kind: AssemblyLayerKind;
  /** Printed under the picture, e.g. "85g smash patty with cheese" */
  label: string;
  /** Sauce colour (hex) — only used by "sauce" */
  color?: string | null;
  /** Own photo/cut-out instead of the drawing — required for "custom" */
  imageUrl?: string | null;
  /** Small red call-out above the layer, e.g. "Check for cheese on order" */
  callout?: string | null;
}

export interface AssemblyChartDto {
  id: string;
  brandId: string;
  name: string;
  nameKey: string;
  /** Header name — defaults to the product name */
  title: string;
  /** Second header line — the same build sold under another brand's name */
  altTitle: string | null;
  /** Burger photo above the column; null = the product photo */
  heroImageUrl: string | null;
  layers: AssemblyLayer[];
  /** Line under the column, e.g. "Cook time 3.5 mins" */
  footNote: string | null;
  updatedAt: string;
}

export const ASSEMBLY_MAX_LAYERS = 24;

/** Sauce colours offered in the editor (any hex is accepted). */
export const ASSEMBLY_SAUCE_COLOURS: Array<{ name: string; hex: string }> = [
  { name: "Ketchup", hex: "#d7261e" },
  { name: "Burger sauce", hex: "#f39a2b" },
  { name: "Mayo", hex: "#f3e6bf" },
  { name: "Garlic mayo", hex: "#efe2c4" },
  { name: "BBQ", hex: "#4a2516" },
  { name: "Mustard", hex: "#e8b81a" },
  { name: "Hot sauce", hex: "#e2531b" },
  { name: "Ranch", hex: "#f4ecd6" },
  { name: "Truffle mayo", hex: "#e8c98a" },
  { name: "Chocolate", hex: "#3b1f14" },
];
