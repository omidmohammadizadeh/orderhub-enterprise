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
 * Fixed rather than a free colour picker, for two reasons: every entry here
 * ships with text that is legible on it (a picker lets someone choose
 * yellow-on-white and make a tile unreadable), and a small set is what makes
 * colour coding work — twenty shades nobody can tell apart is the same as no
 * colours at all.
 */
export const TILE_PALETTE: Array<{
  name: string;
  bg: string;
  border: string;
  /** Text colour. Only set on the dark shades, where near-black is unreadable. */
  fg?: string;
}> = [
  { name: "None", bg: "", border: "" },
  // Pale shades — quiet enough to colour a whole section without the screen
  // turning into a fairground.
  { name: "Light red", bg: "#fee2e2", border: "#fca5a5" },
  { name: "Orange", bg: "#ffedd5", border: "#fdba74" },
  { name: "Amber", bg: "#fef3c7", border: "#fcd34d" },
  { name: "Light green", bg: "#dcfce7", border: "#86efac" },
  { name: "Teal", bg: "#ccfbf1", border: "#5eead4" },
  { name: "Light blue", bg: "#dbeafe", border: "#93c5fd" },
  { name: "Indigo", bg: "#e0e7ff", border: "#a5b4fc" },
  { name: "Violet", bg: "#ede9fe", border: "#c4b5fd" },
  { name: "Pink", bg: "#fce7f3", border: "#f9a8d4" },
  { name: "Slate", bg: "#e2e8f0", border: "#cbd5e1" },
  // Strong shades — for the few tiles that must be found without reading.
  // Each carries white text, because the near-black the tiles use elsewhere
  // is unreadable on these.
  { name: "Red", bg: "#dc2626", border: "#b91c1c", fg: "#ffffff" },
  { name: "Dark blue", bg: "#1e3a8a", border: "#172554", fg: "#ffffff" },
  { name: "Dark green", bg: "#14532d", border: "#0f3d21", fg: "#ffffff" },
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
): { bg: string; border: string; fg?: string } | null {
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
