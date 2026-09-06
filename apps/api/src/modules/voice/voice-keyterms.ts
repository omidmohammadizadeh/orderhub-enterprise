// The words this shop actually sells, handed to the transcriber before it
// listens.
//
// Every accuracy problem on this line has been the transcriber, and the words
// it gets wrong are not random: they are the ones its training data has barely
// seen. "gyros", "souvlaki", "halloumi", "kofte", "calzone", "parmo" — the
// names a Greek or Turkish or Teesside takeaway is built on, arriving as
// "heroes", "civlaki", "coffee". Claude never sees the real word, and no
// amount of matching recovers a sound that was never written down.
//
// Deepgram's nova-3 takes up to 100 keyterms per request and weights them
// during decoding. We have a list of exactly the right words sitting in the
// menu we already loaded.

/** Words every English menu contains, which crowd out the ones that matter. */
const COMMON = new Set([
  "the", "and", "with", "without", "extra", "large", "small", "medium", "regular",
  "meal", "deal", "combo", "special", "mix", "mixed", "half", "full", "single",
  "double", "chips", "fries", "drink", "drinks", "sauce", "salad", "cheese",
  "chicken", "beef", "lamb", "pork", "fish", "veg", "vegetable", "vegetarian",
  "vegan", "hot", "cold", "spicy", "plain", "classic", "original", "new",
  "side", "sides", "starter", "starters", "dessert", "desserts", "kids", "box",
  "wrap", "burger", "pizza", "kebab", "chips", "rice", "naan", "bread", "can",
  "bottle", "coke", "water", "juice", "inch", "pcs", "piece", "pieces", "of",
  "on", "in", "a", "an", "or", "for", "your", "our", "served", "topped",
]);

/** A word worth boosting: unusual, pronounceable, and not a number. */
function worthBoosting(word: string): boolean {
  if (word.length < 4 || word.length > 20) return false;
  if (COMMON.has(word)) return false;
  // Sizes, prices, "330ml" — a transcriber does not need help with digits, and
  // they would burn slots that a dish name needs.
  return !/\d/.test(word);
}

/**
 * The menu, as a list of terms to listen for.
 *
 * Single words rather than whole dish names: a caller says "gyros", not
 * "Chicken Gyros Wrap With Chips", and it is the one unusual word in the name
 * that the transcriber is losing. Ranked by how often the menu uses a word, so
 * a shop whose every item is a gyros spends its budget saying so.
 */
export function keytermsFromMenu(
  items: Array<{ name?: string; modifierGroups?: Array<{ options?: Array<{ name?: string }> }> }>,
  limit = 100,
): string[] {
  const counts = new Map<string, number>();
  const add = (raw: string | undefined): void => {
    for (const word of String(raw ?? "")
      .toLowerCase()
      .replace(/[^a-z\s'-]/g, " ")
      .split(/\s+/)) {
      const w = word.replace(/^['-]+|['-]+$/g, "");
      if (!worthBoosting(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  };

  for (const item of items ?? []) {
    add(item?.name);
    // Option names too: "which sauce?" is answered with the very words a
    // transcriber is worst at, and that answer is now a whole turn of the call.
    for (const group of item?.modifierGroups ?? []) {
      for (const option of group?.options ?? []) add(option?.name);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([word]) => word);
}
