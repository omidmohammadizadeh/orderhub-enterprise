"use client";

// A drawn food graphic for items with no photo.
//
// Most menus launch before anyone photographs 120 dishes, and a grid of grey
// boxes reads as broken rather than "photo pending". These are inline SVG —
// no network request, no layout shift, and they tint to the shape of the dish
// so a menu of placeholders still looks deliberate instead of repetitive.
//
// Which graphic an item gets is derived from its name: a stable hash so the
// same dish always draws the same thing across reloads and devices, with a
// keyword pass first so a pizza actually looks like a pizza.

type Shape = "pizza" | "burger" | "kebab" | "drink" | "chips" | "dessert" | "bowl";

// Word-bounded on purpose. Substring matching draws a can of pop for
// "Ameri-can Hot" and a cake for "pan-cake"-ish names; \b keeps a keyword
// from firing on the inside of an unrelated word.
const KEYWORDS: Array<[RegExp, Shape]> = [
  [/\b(pizzas?|margheritas?|pepperoni|calzones?)\b/i, "pizza"],
  [/\b(burgers?|smash|patty|patties|cheeseburgers?)\b/i, "burger"],
  [/\b(kebabs?|donner|doner|gyros|shawarma|wraps?|shish)\b/i, "kebab"],
  [/\b(drinks?|colas?|coke|pepsi|fanta|water|juices?|shakes?|bottles?|cans?)\b/i, "drink"],
  [/\b(chips?|fries|wedges|nuggets?|sides?|onion rings?)\b/i, "chips"],
  [/\b(cakes?|ice cream|desserts?|brownies?|cookies?|sundaes?|doughnuts?|donuts?|sweets?)\b/i, "dessert"],
  [/\b(salads?|bowls?|rice|pasta|curr(y|ies)|soups?|meals?)\b/i, "bowl"],
];

const SHAPES: Shape[] = ["pizza", "burger", "kebab", "drink", "chips", "dessert", "bowl"];

/** Stable per-name hash so a dish keeps its graphic between loads. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * @param name  The dish. Checked first — it's the most specific signal.
 * @param hint  Its category. Checked second, and it matters more than it
 *              looks: half a pizza menu is named "Spicy Sicilian" or
 *              "American Hot" with no "pizza" in sight, and without the
 *              category those fall through to the hash and a pizza list
 *              draws a cupcake. Only when neither says anything do we hash,
 *              which is stable per name so it never changes under the
 *              customer.
 */
export function shapeFor(name: string, hint?: string): Shape {
  for (const [re, shape] of KEYWORDS) if (re.test(name)) return shape;
  if (hint) for (const [re, shape] of KEYWORDS) if (re.test(hint)) return shape;
  return SHAPES[hash(name) % SHAPES.length]!;
}

// Warm, food-ish grounds. Each pairs a background with ink that stays legible
// on it — picked per shape rather than randomly so a burger is never mint.
const PALETTE: Record<Shape, { bg: string; a: string; b: string; c: string }> = {
  pizza: { bg: "#FFF4E3", a: "#F2B34B", b: "#E2612F", c: "#C2410C" },
  burger: { bg: "#FFF1DE", a: "#E9A44D", b: "#7C4A24", c: "#4E7A32" },
  kebab: { bg: "#FDF2E7", a: "#D98E4B", b: "#8C5A2B", c: "#5F8C3F" },
  drink: { bg: "#EAF4FB", a: "#5FA8D3", b: "#2E6F9E", c: "#F2B34B" },
  chips: { bg: "#FFF6E0", a: "#F0C24B", b: "#D9812F", c: "#B45309" },
  dessert: { bg: "#FDEDF3", a: "#E9A0BE", b: "#C4557F", c: "#7C3A55" },
  bowl: { bg: "#EFF7EA", a: "#8FBF6A", b: "#4E7A32", c: "#E2612F" },
};

/**
 * @param name  Item name — decides the graphic and keeps it stable.
 * @param className  Sized by the caller; the SVG fills its box.
 */
export function FoodPlaceholder({
  name,
  hint,
  className = "",
}: {
  name: string;
  /** Category name — decides the graphic when the dish name gives nothing. */
  hint?: string;
  className?: string;
}) {
  const shape = shapeFor(name ?? "", hint);
  const p = PALETTE[shape];
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label=""
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="100" height="100" fill={p.bg} />
      {shape === "pizza" && (
        <g>
          {/* A slice, point down. */}
          <path d="M50 16 L82 76 Q50 90 18 76 Z" fill={p.a} />
          <path d="M50 24 L76 73 Q50 84 24 73 Z" fill="#FFE0A3" />
          <circle cx="44" cy="52" r="4.5" fill={p.b} />
          <circle cx="60" cy="46" r="3.8" fill={p.b} />
          <circle cx="54" cy="66" r="4.2" fill={p.b} />
          <circle cx="38" cy="68" r="3.2" fill={p.c} />
        </g>
      )}
      {shape === "burger" && (
        <g>
          <path d="M22 44 Q50 20 78 44 Z" fill={p.a} />
          <rect x="21" y="45" width="58" height="7" rx="3.5" fill={p.c} />
          <rect x="21" y="53" width="58" height="9" rx="3" fill={p.b} />
          <rect x="21" y="63" width="58" height="6" rx="3" fill="#F6D36B" />
          <path d="M22 70 Q50 86 78 70 Z" fill={p.a} />
        </g>
      )}
      {shape === "kebab" && (
        <g>
          {/* Wrap, seen end-on. */}
          <path d="M30 78 L46 22 Q50 18 54 22 L70 78 Q50 86 30 78 Z" fill="#F4E0BE" />
          <path d="M40 46 L60 46 L64 62 L36 62 Z" fill={p.b} />
          <circle cx="46" cy="54" r="3" fill={p.c} />
          <circle cx="56" cy="57" r="2.6" fill={p.a} />
        </g>
      )}
      {shape === "drink" && (
        <g>
          <rect x="36" y="26" width="28" height="52" rx="6" fill={p.a} />
          <rect x="36" y="26" width="28" height="12" rx="6" fill={p.b} />
          <rect x="41" y="44" width="18" height="26" rx="3" fill="#FFFFFF" opacity="0.55" />
          <rect x="58" y="14" width="5" height="18" rx="2.5" fill={p.c} transform="rotate(18 60 22)" />
        </g>
      )}
      {shape === "chips" && (
        <g>
          <path d="M34 46 L66 46 L62 82 L38 82 Z" fill={p.b} />
          <rect x="38" y="24" width="6" height="26" rx="3" fill={p.a} transform="rotate(-12 41 37)" />
          <rect x="47" y="20" width="6" height="30" rx="3" fill="#F6D36B" />
          <rect x="56" y="24" width="6" height="26" rx="3" fill={p.a} transform="rotate(12 59 37)" />
          <rect x="34" y="56" width="32" height="7" rx="3" fill="#FFFFFF" opacity="0.35" />
        </g>
      )}
      {shape === "dessert" && (
        <g>
          <path d="M32 52 Q50 30 68 52 Z" fill={p.a} />
          <rect x="32" y="52" width="36" height="10" rx="4" fill="#FFFFFF" opacity="0.6" />
          <path d="M34 62 L66 62 L60 82 L40 82 Z" fill={p.b} />
          <circle cx="50" cy="30" r="4.5" fill={p.c} />
        </g>
      )}
      {shape === "bowl" && (
        <g>
          <path d="M22 50 Q50 44 78 50 L70 78 Q50 86 30 78 Z" fill={p.b} />
          <path d="M26 50 Q50 46 74 50 L70 62 Q50 68 30 62 Z" fill={p.a} />
          <circle cx="40" cy="54" r="3.4" fill={p.c} />
          <circle cx="54" cy="52" r="3" fill="#FFFFFF" opacity="0.75" />
          <circle cx="62" cy="57" r="2.6" fill={p.c} />
        </g>
      )}
    </svg>
  );
}
