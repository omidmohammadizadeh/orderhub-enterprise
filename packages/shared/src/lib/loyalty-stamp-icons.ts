// The stamp icons a walk-in loyalty card can use — one per kind of business.
//
// Each is the inner markup of a 24×24 SVG, drawn to be placed inside a <g>
// that sets BOTH fill and stroke to one colour (the wallet pass, the card
// page, the till and the poster all do this). Solid shapes rely on that fill;
// line parts say fill="none" and set their own stroke-width. No text and no
// second colour, so an icon reads the same filled-in or faded-out, and the
// server can render it with no fonts installed.
//
// Shared by the API (pass artwork via sharp) and the web (card, till,
// dashboard, poster) so every surface shows the same picture.

export type StampIconGroup = "Food & drink" | "Sweets & bakery" | "Drinks & bars" | "Shops" | "Services" | "General";

export interface StampIcon {
  label: string;
  group: StampIconGroup;
  svg: string;
}

const ROUND = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';

export const STAMP_ICONS = {
  // ── Food & drink ─────────────────────────────────────────────────────────
  coffee: {
    label: "Coffee",
    group: "Food & drink",
    svg:
      '<path d="M4 9h12v5.5A5.5 5.5 0 0 1 10.5 20h-1A5.5 5.5 0 0 1 4 14.5V9z"/>' +
      `<path d="M16 10.5h1.5a2.75 2.75 0 0 1 0 5.5H16" ${ROUND} stroke-width="1.8"/>` +
      `<path d="M8 3.5c-.8 1 .8 1.8 0 3M12 3.5c-.8 1 .8 1.8 0 3" ${ROUND} stroke-width="1.5"/>`,
  },
  pizza: {
    label: "Pizza",
    group: "Food & drink",
    svg:
      `<path d="M3.5 6.6C8.6 3.9 15.4 3.9 20.5 6.6" ${ROUND} stroke-width="2.4"/>` +
      '<path fill-rule="evenodd" stroke="none" d="M5 8.7 12 20.6 19 8.7C14.6 7 9.4 7 5 8.7zM10 10.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm4.3.9a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM12 14.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z"/>',
  },
  burger: {
    label: "Burger",
    group: "Food & drink",
    svg:
      '<path d="M4 11a8 6.5 0 0 1 16 0z"/>' +
      '<rect x="3" y="12.4" width="18" height="2.8" rx="1.4"/>' +
      '<path d="M4 16.6h16v1A2.4 2.4 0 0 1 17.6 20H6.4A2.4 2.4 0 0 1 4 17.6z"/>',
  },
  chicken: {
    label: "Chicken",
    group: "Food & drink",
    svg:
      '<path d="M14.6 3.2a6.1 6.1 0 0 1 4.3 10.4 6 6 0 0 1-5.9 1.6l-3 3a2 2 0 1 1-2.5-.3 2 2 0 1 1-.3-2.5l3-3a6 6 0 0 1 1.6-5.9 6 6 0 0 1 2.8-3.3z"/>',
  },
  kebab: {
    label: "Kebab / grill",
    group: "Food & drink",
    svg:
      `<path d="M3.5 20.5 20.5 3.5" ${ROUND} stroke-width="1.6"/>` +
      '<circle cx="7.8" cy="16.2" r="2.7"/><circle cx="12" cy="12" r="2.7"/><circle cx="16.2" cy="7.8" r="2.7"/>',
  },
  fish: {
    label: "Fish & chips",
    group: "Food & drink",
    svg: '<path d="M2.5 12c3.2-4.6 9.2-5.6 13.6-2.1L21 7v10l-4.9-2.9C11.7 17.6 5.7 16.6 2.5 12z"/>',
  },
  noodles: {
    label: "Noodles / Asian",
    group: "Food & drink",
    svg:
      '<path d="M3 11.5h18a9 8.5 0 0 1-18 0z"/>' +
      `<path d="M8.5 10.5 10 3M12.5 10.5 16.5 3.5" ${ROUND} stroke-width="1.7"/>`,
  },
  taco: {
    label: "Mexican",
    group: "Food & drink",
    svg:
      '<path fill-rule="evenodd" stroke="none" d="M2.5 10.5a9.5 9.5 0 0 0 19 0zM6.4 10.5a5.6 5.6 0 0 0 11.2 0z"/>' +
      '<circle cx="7.6" cy="9.6" r="2.2"/><circle cx="10.5" cy="8.4" r="2.2"/><circle cx="13.5" cy="8.4" r="2.2"/><circle cx="16.4" cy="9.6" r="2.2"/>',
  },
  salad: {
    label: "Healthy / vegan",
    group: "Food & drink",
    svg: '<path d="M20 4C9 4 4 9 4 16c0 1.5.3 2.8.8 4 1.2-4.7 4.6-8.4 9.2-10-3.6 2.4-6.2 6-7.2 10.1C14.5 20.5 20 15 20 4z"/>',
  },

  // ── Sweets & bakery ──────────────────────────────────────────────────────
  icecream: {
    label: "Ice cream",
    group: "Sweets & bakery",
    svg: '<circle cx="12" cy="8.2" r="5"/><path d="M7.4 11.2h9.2L12 21.5z"/>',
  },
  cupcake: {
    label: "Cakes / cupcakes",
    group: "Sweets & bakery",
    svg: '<path d="M5 12.5h14l-1.7 8H6.7z"/><path d="M5.8 11.6a6.2 5.4 0 0 1 12.4 0z"/><circle cx="12" cy="4.4" r="1.7"/>',
  },
  donut: {
    label: "Doughnuts",
    group: "Sweets & bakery",
    svg: '<path fill-rule="evenodd" stroke="none" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>',
  },
  sweets: {
    label: "Sweet shop",
    group: "Sweets & bakery",
    svg: '<circle cx="12" cy="12" r="4.6"/><path d="M7.8 10.2 3 7.4v9.2l4.8-2.8zM16.2 10.2 21 7.4v9.2l-4.8-2.8z"/>',
  },
  lollipop: {
    label: "Lollipop",
    group: "Sweets & bakery",
    svg: '<circle cx="12" cy="8.5" r="5.8"/>' + `<path d="M12 14.3V21.5" ${ROUND} stroke-width="2"/>`,
  },
  bread: {
    label: "Bakery",
    group: "Sweets & bakery",
    svg: '<path d="M4 11.5a8 5.5 0 0 1 16 0v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5z"/>',
  },

  // ── Drinks & bars ────────────────────────────────────────────────────────
  bubbletea: {
    label: "Bubble tea / juice",
    group: "Drinks & bars",
    svg:
      '<path d="M6.2 9.5h11.6l-1.4 10.7a1.6 1.6 0 0 1-1.6 1.3H9.2a1.6 1.6 0 0 1-1.6-1.3z"/>' +
      '<rect x="5" y="7" width="14" height="2.3" rx="1.1"/>' +
      `<path d="M13 7 15 2.5" ${ROUND} stroke-width="1.8"/>`,
  },
  beer: {
    label: "Pub / beer",
    group: "Drinks & bars",
    svg:
      '<path d="M5.5 7.5h10v11a2.5 2.5 0 0 1-2.5 2.5H8a2.5 2.5 0 0 1-2.5-2.5z"/>' +
      `<path d="M15.5 10h1.8a2.2 2.2 0 0 1 2.2 2.2v2.1a2.2 2.2 0 0 1-2.2 2.2h-1.8" ${ROUND} stroke-width="1.8"/>` +
      '<path d="M5 7.6a2.4 2.4 0 0 1 2.1-3.7 3.1 3.1 0 0 1 5.3-.4 2.5 2.5 0 0 1 3.6 4.1z"/>',
  },
  cocktail: {
    label: "Cocktail bar",
    group: "Drinks & bars",
    svg: '<path d="M4 4h16l-8 9z"/>' + `<path d="M12 12.5v8M8 20.5h8" ${ROUND} stroke-width="1.8"/>`,
  },
  wine: {
    label: "Wine",
    group: "Drinks & bars",
    svg: '<path d="M7 3h10v4.5a5 5 0 0 1-10 0z"/>' + `<path d="M12 12.5v8M8.5 20.5h7" ${ROUND} stroke-width="1.8"/>`,
  },

  // ── Shops ────────────────────────────────────────────────────────────────
  bag: {
    label: "Retail / shopping",
    group: "Shops",
    svg: '<path d="M5 8h14l-1 13H6z"/>' + `<path d="M9 8V6.5a3 3 0 0 1 6 0V8" ${ROUND} stroke-width="1.8"/>`,
  },
  basket: {
    label: "Grocery",
    group: "Shops",
    svg: '<path d="M3 10h18l-2 10.2H5z"/>' + `<path d="M7.5 10l3-6.2M16.5 10l-3-6.2" ${ROUND} stroke-width="1.8"/>`,
  },
  flower: {
    label: "Florist",
    group: "Shops",
    svg:
      '<circle cx="12" cy="5.6" r="2.9"/><circle cx="7.6" cy="9" r="2.9"/><circle cx="16.4" cy="9" r="2.9"/><circle cx="9.3" cy="13.4" r="2.9"/><circle cx="14.7" cy="13.4" r="2.9"/>' +
      `<path d="M12 15v6.5" ${ROUND} stroke-width="1.8"/>`,
  },
  book: {
    label: "Books / stationery",
    group: "Shops",
    svg: '<path d="M3.5 4.5H10A2 2 0 0 1 12 6.5v14a2 2 0 0 0-2-2H3.5zM20.5 4.5H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6.5z"/>',
  },
  pill: {
    label: "Pharmacy / health",
    group: "Shops",
    svg: '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/>',
  },
  paw: {
    label: "Pet shop / groomer",
    group: "Shops",
    svg:
      '<ellipse cx="12" cy="15.6" rx="4.6" ry="3.9"/><circle cx="5.8" cy="10.2" r="2.1"/><circle cx="9.4" cy="6.4" r="2.1"/><circle cx="14.6" cy="6.4" r="2.1"/><circle cx="18.2" cy="10.2" r="2.1"/>',
  },

  // ── Services ─────────────────────────────────────────────────────────────
  scissors: {
    label: "Barber / hair",
    group: "Services",
    svg:
      `<circle cx="6.5" cy="17.5" r="2.8" ${ROUND} stroke-width="2"/>` +
      `<circle cx="17.5" cy="17.5" r="2.8" ${ROUND} stroke-width="2"/>` +
      `<path d="M8.5 15.4 18 3M15.5 15.4 6 3" ${ROUND} stroke-width="2.2"/>`,
  },
  comb: {
    label: "Grooming",
    group: "Services",
    svg:
      '<rect x="3" y="7" width="18" height="3.6" rx="1"/>' +
      `<path d="M4.8 10.6v7M7.9 10.6v7M11 10.6v7M14.1 10.6v7M17.2 10.6v7M20.2 10.6v4" ${ROUND} stroke-width="1.6"/>`,
  },
  lipstick: {
    label: "Beauty / nails",
    group: "Services",
    svg: '<path d="M8.8 10.5h6.4v10.5H8.8zM10 10.5V5.6L14 3v7.5z"/>',
  },
  car: {
    label: "Car wash / garage",
    group: "Services",
    svg:
      '<path d="M5 11l1.8-4.2a2 2 0 0 1 1.8-1.3h6.8a2 2 0 0 1 1.8 1.3L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17h-2v1.5a1.5 1.5 0 0 1-3 0V17H8v1.5a1.5 1.5 0 0 1-3 0V17H3v-4.5A1.5 1.5 0 0 1 4.5 11z"/>',
  },
  dumbbell: {
    label: "Gym / fitness",
    group: "Services",
    svg:
      '<rect x="2" y="9" width="3" height="6" rx="1"/><rect x="5" y="6.5" width="3.2" height="11" rx="1"/>' +
      '<rect x="15.8" y="6.5" width="3.2" height="11" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/>' +
      '<rect x="8" y="10.8" width="8" height="2.4"/>',
  },
  shirt: {
    label: "Laundry / dry cleaning",
    group: "Services",
    svg: '<path d="M8.5 3 3 6l2 4.2 2-1V21h10V9.2l2 1L21 6l-5.5-3a3.5 3.5 0 0 1-7 0z"/>',
  },

  // ── General ──────────────────────────────────────────────────────────────
  star: {
    label: "Star",
    group: "General",
    svg: '<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/>',
  },
  heart: {
    label: "Heart",
    group: "General",
    svg: '<path d="M12 20.5S4 15.8 4 10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 10.5-8 10.5z"/>',
  },
  check: {
    label: "Tick",
    group: "General",
    svg: `<path d="M4.5 12.5 9.5 17.5 19.5 6.5" ${ROUND} stroke-width="3.2"/>`,
  },
} satisfies Record<string, StampIcon>;

export type StampIconKey = keyof typeof STAMP_ICONS;

export const DEFAULT_STAMP_ICON: StampIconKey = "coffee";

/** The final, reward slot on every card. */
export const REWARD_ICON_SVG =
  '<path d="M3.5 9.5h17v3h-17zM5 12.5h14V20H5z"/>' +
  '<path d="M12 9.5V20" fill="none" stroke-width="1.6"/>' +
  '<path d="M12 9.5C10 5 6.5 5.5 7.5 8c.4 1 2.5 1.5 4.5 1.5zM12 9.5c2-4.5 5.5-4 4.5-1.5-.4 1-2.5 1.5-4.5 1.5z" fill="none" stroke-width="1.5"/>';

export function isStampIconKey(v: unknown): v is StampIconKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STAMP_ICONS, v);
}

/** The icon's SVG markup, falling back to the coffee cup for anything unknown. */
export function stampIconSvg(key: string | null | undefined): string {
  return isStampIconKey(key) ? STAMP_ICONS[key].svg : STAMP_ICONS[DEFAULT_STAMP_ICON].svg;
}

/** Icons in display order, grouped for a picker. */
export function stampIconGroups(): Array<{ group: StampIconGroup; icons: Array<{ key: StampIconKey } & StampIcon> }> {
  const order: StampIconGroup[] = ["Food & drink", "Sweets & bakery", "Drinks & bars", "Shops", "Services", "General"];
  return order.map((group) => ({
    group,
    icons: (Object.entries(STAMP_ICONS) as Array<[StampIconKey, StampIcon]>)
      .filter(([, i]) => i.group === group)
      .map(([key, i]) => ({ key, ...i })),
  }));
}

/** A sensible first icon for a business type, before the operator picks one. */
export function suggestedStampIcon(businessType: string | null | undefined): StampIconKey {
  switch (String(businessType ?? "").toUpperCase()) {
    case "GROCERY":
      return "basket";
    case "RETAIL":
      return "bag";
    case "SALON":
      return "scissors";
    default:
      return DEFAULT_STAMP_ICON;
  }
}
