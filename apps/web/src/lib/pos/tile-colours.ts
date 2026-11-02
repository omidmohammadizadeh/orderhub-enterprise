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

// ── Tile size ───────────────────────────────────────────────────────────────
//
// A POS screen might be a 24" counter monitor or an 8" tablet propped by the
// phone, and the right tile is a different size on each. Rather than a pixel
// value nobody can reason about, four named steps that move the grid AND the
// text together — a bigger tile with the same tiny label is just more empty
// box, which is the mistake a raw width slider invites.

export type TileSize = "S" | "M" | "L" | "XL";

export const TILE_SIZES: Record<
  TileSize,
  {
    label: string;
    hint: string;
    /** Square tiles, as many columns as fit: a wider minimum is a bigger tile. */
    grid: string;
    /** Product tile. */
    pad: string;
    name: string;
    price: string;
    /** Category chip, so the two scale together. */
    chip: string;
  }
> = {
  S: {
    label: "Small",
    hint: "Most items on screen",
    grid: "grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]",
    pad: "p-2",
    name: "text-xs",
    price: "text-xs",
    chip: "px-2.5 py-1 text-[11px]",
  },
  M: {
    label: "Medium",
    hint: "Default",
    grid: "grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))]",
    pad: "p-2.5",
    name: "text-sm",
    price: "text-sm",
    chip: "px-3 py-1.5 text-xs",
  },
  L: {
    label: "Large",
    hint: "Easier to hit mid-rush",
    grid: "grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]",
    pad: "p-3",
    name: "text-base",
    price: "text-base",
    chip: "px-4 py-2 text-sm",
  },
  XL: {
    label: "Extra large",
    hint: "Small screens, gloved hands",
    grid: "grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]",
    pad: "p-4",
    name: "text-lg",
    price: "text-lg",
    chip: "px-5 py-2.5 text-base",
  },
};

export const DEFAULT_TILE_SIZE: TileSize = "M";

export function tileSizeFromSettings(settings: unknown): TileSize {
  const v = (settings as any)?.pos?.tileSize;
  return v && v in TILE_SIZES ? (v as TileSize) : DEFAULT_TILE_SIZE;
}

// ── Category bar ────────────────────────────────────────────────────────────
//
// Where the till's categories sit beside the products on a tablet, and how big
// their buttons are. Phones keep the category tiles, which follow the tile
// size above. Every class is written out in full so Tailwind can see it.

export type CategoryPlacement = "AUTO" | "SIDE" | "TOP";
export type CategorySize = "S" | "M" | "L" | "XL";

export const CATEGORY_PLACEMENTS: Record<
  CategoryPlacement,
  { label: string; hint: string }
> = {
  AUTO: { label: "Automatic", hint: "Top on tablets, side on wide screens" },
  SIDE: { label: "Side", hint: "A column down the left" },
  TOP: { label: "Top", hint: "Rows above the products" },
};

export const CATEGORY_SIZES: Record<
  CategorySize,
  {
    label: string;
    /** Button height, text and padding. */
    button: string;
    /** Rows wrap above the products; past this height they scroll. */
    topMaxHeight: string;
  }
> = {
  S: { label: "Small", button: "h-9 px-3 text-xs", topMaxHeight: "max-h-[7.5rem]" },
  M: { label: "Medium", button: "h-11 px-3.5 text-sm", topMaxHeight: "max-h-[9.5rem]" },
  L: { label: "Large", button: "h-14 px-4 text-base", topMaxHeight: "max-h-[12rem]" },
  XL: { label: "Extra large", button: "h-16 px-5 text-lg", topMaxHeight: "max-h-[13.5rem]" },
};

// The column's width grows with its buttons.
const SIDE_WIDTH: Record<CategorySize, { md: string; xl: string }> = {
  S: { md: "md:w-44", xl: "xl:w-44" },
  M: { md: "md:w-52", xl: "xl:w-52" },
  L: { md: "md:w-60", xl: "xl:w-60" },
  XL: { md: "md:w-72", xl: "xl:w-72" },
};

/** Classes for the menu area, the category bar and its buttons. */
export function categoryBarClasses(placement: CategoryPlacement, size: CategorySize) {
  const sz = CATEGORY_SIZES[size];
  if (placement === "TOP") {
    return {
      area: "",
      nav: `${sz.topMaxHeight} flex-wrap gap-1.5`,
      button: "",
      selected: "",
      unselected: "",
      label: "",
      count: "hidden",
    };
  }
  if (placement === "SIDE") {
    return {
      area: "md:flex-row",
      nav: `md:max-h-none ${SIDE_WIDTH[size].md} md:flex-col md:flex-nowrap md:gap-1 md:rounded-xl md:border md:border-zinc-200 md:bg-white md:p-2`,
      button: "md:w-full md:border-transparent md:px-3",
      selected: "md:border-zinc-900",
      unselected: "md:hover:border-transparent md:hover:bg-zinc-100",
      label: "md:flex-1 md:text-left",
      count: "hidden md:inline",
    };
  }
  return {
    area: "xl:flex-row",
    nav: `${sz.topMaxHeight} flex-wrap gap-1.5 xl:max-h-none ${SIDE_WIDTH[size].xl} xl:flex-col xl:flex-nowrap xl:gap-1 xl:rounded-xl xl:border xl:border-zinc-200 xl:bg-white xl:p-2`,
    button: "xl:w-full xl:border-transparent xl:px-3",
    selected: "xl:border-zinc-900",
    unselected: "xl:hover:border-transparent xl:hover:bg-zinc-100",
    label: "xl:flex-1 xl:text-left",
    count: "hidden xl:inline",
  };
}

export function categoryPlacementFromSettings(settings: unknown): CategoryPlacement {
  const v = (settings as any)?.pos?.categoryPlacement;
  return v && v in CATEGORY_PLACEMENTS ? (v as CategoryPlacement) : "AUTO";
}

export function categorySizeFromSettings(settings: unknown): CategorySize {
  const v = (settings as any)?.pos?.categorySize;
  return v && v in CATEGORY_SIZES ? (v as CategorySize) : "M";
}
