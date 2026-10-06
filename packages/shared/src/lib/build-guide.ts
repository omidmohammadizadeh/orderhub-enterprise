/**
 * "How to build" kitchen guides — shared between the API (which stores a
 * guide under brand + nameKey) and the web (which decides whether an order
 * line has a guide before showing the button).
 *
 * Guides are matched by product NAME because order lines from marketplaces
 * often carry no menuItemId, and a menu cloned to another location copies its
 * items with new ids. The name is the one thing every copy has in common.
 */

export interface BuildGuideStep {
  id: string;
  text: string;
  imageUrl?: string | null;
  /** "2 scoops", "120g" — optional, printed as a badge next to the step */
  amount?: string | null;
  /** "Spatula", "Squeeze bottle" — optional tool tags */
  tools?: string[];
}

export interface BuildGuideDto {
  id: string;
  brandId: string;
  name: string;
  nameKey: string;
  steps: BuildGuideStep[];
  packNote: string | null;
  updatedAt: string;
}

export const BUILD_GUIDE_MAX_STEPS = 30;

/** "Chicken Burger (Large)" → "chicken burger large". Accents and punctuation dropped. */
export function buildGuideNameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9؀-ۿ一-鿿]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Which guide key serves this order line? Exact name first; otherwise the
 * longest guide key the line STARTS with on a word boundary — a marketplace
 * line called "Chicken Burger Large" still finds the "Chicken Burger" guide,
 * but "Chicken" never swallows "Chicken Wings" when both exist.
 */
export function matchBuildGuideKey(
  lineName: string | null | undefined,
  keys: Iterable<string>,
): string | null {
  const line = buildGuideNameKey(lineName);
  if (!line) return null;
  let best: string | null = null;
  for (const key of keys) {
    if (!key) continue;
    if (key === line) return key;
    if (line.startsWith(key + " ") && (!best || key.length > best.length)) best = key;
  }
  return best;
}
