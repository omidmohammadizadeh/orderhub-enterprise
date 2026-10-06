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
  /**
   * Modifier-aware steps. `onlyWith`: the step is for an extra — shown
   * highlighted when the order has one of these modifiers, greyed out as
   * "not ordered" otherwise. `skipWith`: a step the customer can remove
   * ("No onion") — struck through when one of these is on the order.
   * Both hold modifier option NAMES, matched with buildGuideNameKey.
   */
  onlyWith?: string[];
  skipWith?: string[];
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

/** Does an ordered modifier satisfy a step condition? Exact key, or the
 *  condition's words appearing whole inside the modifier ("Cheese" matches
 *  "Extra Cheese", never "Cheesecake"). */
function modifierMatches(conditionKey: string, modifierKey: string): boolean {
  if (!conditionKey || !modifierKey) return false;
  if (conditionKey === modifierKey) return true;
  return ` ${modifierKey} `.includes(` ${conditionKey} `);
}

export type BuildStepState = "always" | "added" | "notOrdered" | "skipped";

/**
 * How a step applies to THIS order line, given the names of its modifiers.
 * A skip beats an add: "No sauce" wins even if the step also lists "Sauce".
 */
export function buildStepState(
  step: Pick<BuildGuideStep, "onlyWith" | "skipWith">,
  modifierNames: Array<string | null | undefined>,
): { state: BuildStepState; matched: string[] } {
  const mods = modifierNames
    .map((n) => ({ name: String(n ?? ""), key: buildGuideNameKey(n) }))
    .filter((m) => m.key);
  const hits = (conds?: string[]) =>
    mods
      .filter((m) => (conds ?? []).some((c) => modifierMatches(buildGuideNameKey(c), m.key)))
      .map((m) => m.name);

  const skipped = hits(step.skipWith);
  if (skipped.length) return { state: "skipped", matched: skipped };
  if ((step.onlyWith ?? []).filter((c) => buildGuideNameKey(c)).length) {
    const added = hits(step.onlyWith);
    return added.length ? { state: "added", matched: added } : { state: "notOrdered", matched: [] };
  }
  return { state: "always", matched: [] };
}
