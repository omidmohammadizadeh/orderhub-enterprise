// Working out what the caller actually ordered.
//
// The transcriber does not know the menu. On a real call "three cola" came
// back as "Drie coli", and asking a language model to pick an exact item id
// out of that leaves it two bad options: guess, or ask again. Guessing puts
// the wrong food in the kitchen; asking again on every item is what makes a
// four-item order take two minutes.
//
// So the matching happens here, before the model has to commit to anything.
// It is deterministic, it is testable against real mis-hearings, and it can
// say "I am not sure between these two" — which is a far better thing to hand
// a model than a menu and a mangled string.

/** Letters only, lowercased. */
const plain = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * A crude phonetic fold, aimed squarely at how speech engines get food wrong.
 *
 * Two ideas do most of the work. Voiced and voiceless pairs are constantly
 * swapped over a phone line — d/t, b/p, g/k, v/f — which is why "three" came
 * back as "Drie". And vowels are the least reliable part of any transcript, so
 * after the first letter they are dropped entirely: "cola" and "coli" fold to
 * the same thing, while "coke" stays different from both.
 */
export function soundFold(word: string): string {
  let w = plain(word).replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/x/g, "ks")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    // Voiced → voiceless. The pairs a phone line loses most often.
    .replace(/d/g, "t")
    .replace(/b/g, "p")
    .replace(/g/g, "k")
    .replace(/v/g, "f");
  // Doubles carry no sound of their own.
  w = w.replace(/(.)\1+/g, "$1");
  const first = w[0] ?? "";
  return first + w.slice(1).replace(/[aeiou]/g, "");
}

/** Levenshtein, capped — we only care about near misses. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const near = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  const d = distance(a, b);
  // One edit on a short word, two on a long one. Anything looser starts
  // matching genuinely different dishes to each other.
  return d <= (Math.min(a.length, b.length) >= 6 ? 2 : 1);
};

/**
 * What people order versus what the menu calls it.
 *
 * "chips" scored ZERO against a menu selling "French Fries", and "a coke"
 * could not reach the confidence bar against "Coca-Cola 330ml". No amount of
 * phonetic folding fixes that, because the caller and the menu are using
 * different words for the same food. Both directions are listed so the table
 * reads the way a person would check it.
 */
const SYNONYMS: Record<string, string[]> = {
  chips: ["fries", "frenchfries"],
  fries: ["chips"],
  coke: ["cola", "cocacola", "coca"],
  cola: ["coke", "cocacola", "coca"],
  cocacola: ["coke", "cola"],
  pepsi: ["cola", "coke"],
  lemonade: ["sprite", "7up", "seven"],
  sprite: ["lemonade", "7up"],
  fanta: ["orange"],
  donner: ["doner", "donor", "kebab"],
  doner: ["donner", "donor", "kebab"],
  kebab: ["doner", "donner"],
  pop: ["drink", "soda"],
  soda: ["drink", "pop"],
  starter: ["starters", "sides"],
  side: ["sides"],
  burger: ["burgers"],
  wrap: ["wraps"],
  pizza: ["pizzas"],
  naan: ["nan"],
  poppadom: ["papadum", "popadom", "poppadum"],
  aubergine: ["eggplant"],
  courgette: ["zucchini"],
  prawn: ["shrimp", "prawns"],
  shrimp: ["prawn", "prawns"],
  aioli: ["garlicmayo"],
  ketchup: ["tomatosauce"],
};

/** Every word that could stand in for this one, itself included. */
function withSynonyms(token: string): string[] {
  const extra = SYNONYMS[token];
  return extra ? [token, ...extra] : [token];
}

/** Words that carry no meaning on a menu and only dilute the score. */
const NOISE = new Set([
  "a", "an", "the", "and", "with", "of", "please", "can", "i", "get", "have",
  "want", "like", "some", "one", "order", "just", "also", "another", "plus",
  "for", "me", "us", "do", "you", "got", "any",
]);

/**
 * How well does what the caller said match this menu item?
 *
 * 0 to 1. Built out of tokens rather than the whole string because callers say
 * "a large pepperoni pizza please" for an item called "Pepperoni Pizza", and
 * any whole-string measure scores that badly for no good reason.
 */
export function scoreItem(said: string, itemName: string): number {
  const q = plain(said).split(" ").filter((t) => t && !NOISE.has(t));
  const n = plain(itemName).split(" ").filter((t) => t && !NOISE.has(t));
  if (!q.length || !n.length) return 0;

  if (q.join(" ") === n.join(" ")) return 1;

  // A caller's single word can be the whole dish under another name. Token
  // coverage scores "chips" as half of "French Fries" and half is never
  // confident, so the phrase has to be checked as a phrase.
  const nJoined = n.join("");
  if (q.some((t) => withSynonyms(t).includes(nJoined))) return 1;

  let hits = 0;
  for (const nameToken of n) {
    const fold = soundFold(nameToken);
    const hit = q.some(
      (queryToken) =>
        queryToken === nameToken ||
        near(queryToken, nameToken) ||
        soundFold(queryToken) === fold ||
        near(soundFold(queryToken), fold) ||
        // Synonyms are looked up, never folded. Running them through the
        // phonetic match as well widened the net until "greek" reached
        // "coke" — and so "greek olives" scored a perfect 1.0 for Coca Cola.
        withSynonyms(queryToken).includes(nameToken) ||
        withSynonyms(nameToken).includes(queryToken),
    );
    if (hit) hits++;
  }
  // Scored against the ITEM's words, not the caller's: someone saying "can I
  // get a large pepperoni pizza" should score 1 for "Pepperoni Pizza", and
  // the extra words they said are not the item's problem.
  const coverage = hits / n.length;

  // A single-word item matched by a single word is weaker evidence than a
  // two-word item matched by both, so long names that match fully win ties.
  const specificity = Math.min(1, n.length / 3) * 0.15;
  return Math.min(1, coverage + (coverage === 1 ? specificity : 0));
}

export interface MenuMatch<T> {
  item: T;
  score: number;
}

/**
 * Rank the menu against what was heard.
 *
 * Returns everything above the floor, best first, so the caller can be given a
 * choice between two plausible dishes rather than served the wrong one.
 */
export function matchMenuItems<T extends { name: string }>(
  said: string,
  items: T[],
  opts: { limit?: number; floor?: number } = {},
): Array<MenuMatch<T>> {
  const floor = opts.floor ?? 0.5;
  return items
    .map((item) => ({ item, score: scoreItem(said, item.name) }))
    .filter((m) => m.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
}

/**
 * Is the best match good enough to act on without asking?
 *
 * Two conditions, and both matter. It has to be a strong match on its own, and
 * it has to be clearly better than the runner-up — "Chicken Burger" and
 * "Chicken Wrap" both scoring 0.8 is not a decision anyone should make on the
 * caller's behalf.
 */
export function isConfident<T>(matches: Array<MenuMatch<T>>): boolean {
  const [best, second] = matches;
  if (!best || best.score < 0.75) return false;
  return !second || best.score - second.score >= 0.2;
}

const QUANTITY_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2, pair: 2,
};

/**
 * Pull a leading quantity off what the caller said.
 *
 * "Drie coli" is a real transcript of "three cola": the number is the part the
 * engine mangles most, because it is said fastest. Number words are matched
 * through the same phonetic fold as everything else, so "drie" still finds
 * three.
 */
export function splitQuantity(said: string): { quantity: number; rest: string } {
  const tokens = plain(said).split(" ").filter(Boolean);
  const first = tokens[0];
  if (!first) return { quantity: 1, rest: "" };

  if (/^\d+$/.test(first)) {
    const n = Number(first);
    if (n >= 1 && n <= 50) return { quantity: n, rest: tokens.slice(1).join(" ") };
  }

  const fold = soundFold(first);
  for (const [word, n] of Object.entries(QUANTITY_WORDS)) {
    if (first === word || soundFold(word) === fold) {
      // "a" and "an" are articles as often as they are quantities, so they
      // only count when something follows them.
      if (tokens.length === 1) break;
      return { quantity: n, rest: tokens.slice(1).join(" ") };
    }
  }
  return { quantity: 1, rest: tokens.join(" ") };
}

// ── Sizes ──────────────────────────────────────────────────────────────────
//
// A menu with sizes arrives here already flattened: "Margherita (10\")",
// "Margherita (12\")", "Margherita (14\")" are three separate entries. Scoring
// the caller's words against those names directly cannot work, and a probe
// against the real matcher showed exactly how badly:
//
//   a large margherita   confident=false   (10"):0.50  (12"):0.50  (14"):0.50
//
// The size suffix drags coverage under the confidence bar, and the variants
// tie with each other so the clear-leader test can never pass either. Every
// pizza order was therefore an interrogation, no matter how plainly it was
// said. So: match on the BASE name, and treat the size as a separate question
// that the caller has usually already answered.

/** "Margherita (10\")" → { base: "Margherita", size: '10\"' } */
export function splitSize(name: string): { base: string; size: string | null } {
  const m = String(name ?? "").match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m || !m[1]?.trim()) return { base: String(name ?? "").trim(), size: null };
  return { base: m[1].trim(), size: m[2]!.trim() };
}

/** Size words a caller actually says, in the order a menu lists them. */
const SIZE_RANK: Array<{ words: string[]; rank: "first" | "middle" | "last" }> = [
  { words: ["small", "regular", "reg", "standard", "individual"], rank: "first" },
  { words: ["medium", "med"], rank: "middle" },
  { words: ["large", "big", "family", "king"], rank: "last" },
];

const NUMBER_WORDS: Record<string, number> = {
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20,
};

/** Every number a string mentions, words or digits. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const token of plain(text).split(" ")) {
    if (!token) continue;
    if (/^\d+$/.test(token)) out.push(Number(token));
    else if (NUMBER_WORDS[token] !== undefined) out.push(NUMBER_WORDS[token]!);
  }
  return out;
}

/** Does the caller's utterance name a size at all? */
export function mentionsSize(said: string): boolean {
  const p = plain(said);
  if (SIZE_RANK.some((s) => s.words.some((w) => new RegExp(`\\b${w}\\b`).test(p)))) return true;
  return /\b(inch|inches|"|litre|liter|ml|pint|pieces?|pcs)\b/.test(p) || numbersIn(said).length > 0;
}

/**
 * Strip the parts of an utterance that describe a size rather than a dish.
 *
 * "a large margherita" has to score against "Margherita" as though the caller
 * had said only the dish — otherwise the extra word is a penalty for being
 * specific, which is the opposite of what it should be.
 */
export function stripSizeWords(said: string): string {
  let p = plain(said);
  for (const s of SIZE_RANK) {
    for (const w of s.words) p = p.replace(new RegExp(`\\b${w}\\b`, "g"), " ");
  }
  // Spelled-out sizes go first: strip the bare "inch" and "twelve inch
  // pepperoni" is left holding a stray twelve.
  for (const w of Object.keys(NUMBER_WORDS)) {
    p = p.replace(new RegExp(`\\b${w}\\s+(inch|inches)\\b`, "g"), " ");
  }
  p = p
    .replace(/\b\d+\s*(inch|inches|ml|l|litres?|liters?|pieces?|pcs)\b/g, " ")
    .replace(/\b(inch|inches)\b/g, " ");
  return p.replace(/\s+/g, " ").trim();
}

export interface ItemGroup<T> {
  /** The dish, without its size. */
  base: string;
  /** Every size of it, menu order preserved. */
  variants: T[];
}

/** Collapse a flattened menu back into dishes-with-sizes. */
export function groupBySize<T extends { name: string }>(items: T[]): Array<ItemGroup<T>> {
  const groups = new Map<string, ItemGroup<T>>();
  for (const item of items) {
    const { base } = splitSize(item.name);
    const key = plain(base);
    const hit = groups.get(key);
    if (hit) hit.variants.push(item);
    else groups.set(key, { base, variants: [item] });
  }
  return [...groups.values()];
}

export interface GroupMatch<T> {
  group: ItemGroup<T>;
  score: number;
}

/**
 * Rank the menu's DISHES against what was heard, sizes set aside.
 *
 * This is the version the ordering flow should use. matchMenuItems still
 * exists for callers that genuinely want one entry per size.
 */
export function matchItemGroups<T extends { name: string }>(
  said: string,
  items: T[],
  opts: { limit?: number; floor?: number } = {},
): Array<GroupMatch<T>> {
  const floor = opts.floor ?? 0.5;
  const query = stripSizeWords(said) || plain(said);
  return groupBySize(items)
    .map((group) => ({
      group,
      // "Coca-Cola 330ml" is two words of name and one of packaging; scoring
      // the packaging as a third of the dish is what kept "a coke" at 0.67.
      score: scoreItem(query, stripSizeWords(group.base) || group.base),
    }))
    .filter((m) => m.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
}

/** Same bar as isConfident, over dishes rather than sizes. */
export function isConfidentGroup<T>(matches: Array<GroupMatch<T>>): boolean {
  const [best, second] = matches;
  if (!best || best.score < 0.75) return false;
  return !second || best.score - second.score >= 0.2;
}

/**
 * Which size did they ask for?
 *
 * Three ways, in order of how directly the caller said it: a number that
 * appears in the size label ("twelve inch" → 12"), the size's own word
 * ("large" → Large), and failing both, small/medium/large read as a position
 * in the list — which is how anyone ordering a 10/12/14 pizza means it.
 */
export function pickVariant<T extends { name: string }>(
  said: string,
  variants: T[],
): T | null {
  if (variants.length <= 1) return variants[0] ?? null;
  const sized = variants.map((v) => ({ v, size: splitSize(v.name).size ?? "" }));

  const spokenNumbers = numbersIn(said);
  if (spokenNumbers.length) {
    for (const n of spokenNumbers) {
      const hit = sized.find(({ size }) => numbersIn(size).includes(n));
      if (hit) return hit.v;
    }
  }

  const p = plain(said);
  for (const { v, size } of sized) {
    const label = plain(size);
    if (label && new RegExp(`\\b${label.replace(/[^a-z0-9 ]/g, "")}\\b`).test(p)) return v;
  }

  const spokenRank = SIZE_RANK.find((s) =>
    s.words.some((w) => new RegExp(`\\b${w}\\b`).test(p)),
  );
  if (!spokenRank) return null;
  // Only order by number when every size actually has one — otherwise menu
  // order is the shop's own smallest-to-largest and is the better guide.
  const numeric = sized.every(({ size }) => numbersIn(size).length > 0);
  const ordered = numeric
    ? [...sized].sort((a, b) => (numbersIn(a.size)[0] ?? 0) - (numbersIn(b.size)[0] ?? 0))
    : sized;
  if (spokenRank.rank === "first") return ordered[0]!.v;
  if (spokenRank.rank === "last") return ordered[ordered.length - 1]!.v;
  return ordered[Math.floor((ordered.length - 1) / 2)]!.v;
}

/**
 * The sizes, as a question worth hearing.
 *
 * "Margherita (10\"), Margherita (12\") or Margherita (14\")" is what the menu
 * looks like and nobody should ever have it read to them.
 */
export function sizesAloud<T extends { name: string }>(variants: T[]): string {
  const labels = variants
    .map((v) => splitSize(v.name).size)
    .filter((s): s is string => !!s)
    .map((s) => s.replace(/"/g, " inch").replace(/\s+/g, " ").trim());
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
