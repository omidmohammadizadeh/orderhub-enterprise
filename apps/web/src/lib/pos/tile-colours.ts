// Colour coding for the POS menu tiles.
//
// Staff don't read tile labels at speed — they reach for a position and a
// colour. Letting a shop paint Pizzas red and Drinks blue turns the menu into
// something recognisable at arm's length during a rush, which is worth more
// than any amount of typography.
//
// Stored per LOCATION rather than per user or per device: it's a property of
// how that shop's staff are trained, and it has to look the same on the till,
// the second till and the tablet behind the counter.

/** Category id → colour, and item id → colour for the overrides. */
export interface TileColours {
  categories: Record<string, string>;
  items: Record<string, string>;
}

export const EMPTY_TILE_COLOURS: TileColours = { categories: {}, items: {} };

/**
 * The palette.
 *
 * Fixed rather than a free colour picker, for two reasons: every one of these
 * is legible with the same near-black text at a glance (a picker lets someone
 * choose yellow-on-white and make a tile unreadable), and a small set is what
 * makes colour coding work — twenty shades nobody can tell apart is the same
 * as no colours at all.
 */
export const TILE_PALETTE: Array<{ name: string; bg: string; border: string }> = [
  { name: "None", bg: "", border: "" },
  { name: "Red", bg: "#fee2e2", border: "#fca5a5" },
  { name: "Orange", bg: "#ffedd5", border: "#fdba74" },
  { name: "Amber", bg: "#fef3c7", border: "#fcd34d" },
  { name: "Green", bg: "#dcfce7", border: "#86efac" },
  { name: "Teal", bg: "#ccfbf1", border: "#5eead4" },
  { name: "Blue", bg: "#dbeafe", border: "#93c5fd" },
  { name: "Indigo", bg: "#e0e7ff", border: "#a5b4fc" },
  { name: "Violet", bg: "#ede9fe", border: "#c4b5fd" },
  { name: "Pink", bg: "#fce7f3", border: "#f9a8d4" },
  { name: "Slate", bg: "#e2e8f0", border: "#cbd5e1" },
];

export function paletteEntry(bg: string | undefined) {
  return TILE_PALETTE.find((p) => p.bg === bg) ?? null;
}

/**
 * The colour a tile should actually be.
 *
 * Item beats category — that's what "override" means. An item with no colour
 * of its own inherits the category, which is how a shop paints a whole section
 * in one tap and only reaches for individual items to make a bestseller stand
 * out.
 */
export function resolveTileColour(
  colours: TileColours | null | undefined,
  itemId: string,
  categoryId: string | null | undefined,
): { bg: string; border: string } | null {
  if (!colours) return null;
  const bg =
    colours.items?.[itemId] ??
    (categoryId ? colours.categories?.[categoryId] : undefined);
  if (!bg) return null;
  return paletteEntry(bg) ?? { bg, border: bg };
}

/** Reads the map off a location's settings blob, tolerating older shapes. */
export function tileColoursFromSettings(settings: unknown): TileColours {
  const pos = (settings as any)?.pos?.tileColours;
  return {
    categories: pos?.categories ?? {},
    items: pos?.items ?? {},
  };
}
