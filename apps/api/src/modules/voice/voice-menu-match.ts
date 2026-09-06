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
  const shortest = Math.min(a.length, b.length);
  // Under four characters, only an exact match counts.
  //
  // This is where "it doesn't understand food" actually lived. The phonetic
  // fold crushes short words to two or three consonants — solo→"sl",
  // meal→"ml", mega→"mk", duet→"tt" — and allowing one edit on those made
  // nearly every short word a near miss for every other one:
  //
  //   scoreItem("solo", "Meal") = 1        "sl" vs "ml"
  //   scoreItem("meal", "Mega") = 1        "ml" vs "mk"
  //
  // So "Solo meal", said perfectly, tied 1.00 with Mega Meal and the caller
  // was asked which they meant — every time. One edit on a two-character
  // string is not a near miss, it is a different word.
  if (shortest < 4) return false;
  const d = distance(a, b);
  return d <= (shortest >= 6 ? 2 : 1);
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
  // The words a transcriber has never been trained on. Each of these has come
  // back mangled from a real UK takeaway line, and they are exactly the words
  // the shop's best-selling items are named after.
  gyros: ["gyro", "giro", "yeeros", "jairos", "heroes"],
  souvlaki: ["suvlaki", "sovlaki", "souvlakia", "civlaki"],
  shawarma: ["shwarma", "schwarma", "shawama"],
  kofte: ["kofta", "kufta", "koftay", "coffee"],
  halloumi: ["haloumi", "hallumi", "halumi"],
  tikka: ["tika", "ticka", "teeka"],
  peri: ["piri", "perry"],
  falafel: ["felafel", "falafal"],
  bhaji: ["bhajee", "badgie", "bargy"],
  pakora: ["pakoda", "packora"],
  katsu: ["katsuo", "catsu"],
  chorizo: ["choritso", "chorizzo"],
  ketchup: ["tomatosauce"],
};

/** "cokes" -> "coke". Crude on purpose: it only feeds the synonym lookup. */
function singular(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

/** Every word that could stand in for this one, itself included. */
function withSynonyms(token: string): string[] {
  // People order in plurals — "three cokes", "chips", "two wraps" — and the
  // table is written in the singular. Without this, "three cokes" scored 0.5
  // against Coca-Cola and went to the model.
  const forms = new Set([token, singular(token)]);
  const out = new Set(forms);
  for (const form of forms) for (const syn of SYNONYMS[form] ?? []) out.add(syn);
  return [...out];
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
        // People shorten what they order — "a large marg", "two pepp". Four
        // characters is the floor: shorter than that and "gar" starts matching
        // garlic bread, garlic mayo and gammon at once.
        (queryToken.length >= 4 && nameToken.startsWith(queryToken)) ||
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

  // "12 inch pepperoni" is one pizza, not twelve.
  //
  // A leading number is nearly always how many they want — except when the
  // next word is a unit, at which point it is the size of the thing. Read as a
  // quantity it put TWELVE pepperoni pizzas in a cart, £93.60 of them, off a
  // caller asking for one.
  const unitNext =
    /^(inch(es)?|in|cm|mm|ml|cl|l|ltr|litre|g|kg|oz|pt)$/i.test(tokens[1] ?? "") ||
    // The quote in `12"` does not survive being reduced to letters and
    // digits, so the raw string is where it has to be seen.
    /^\s*\d+\s*(?:"|''|”|″)/.test(String(said ?? ""));

  if (/^\d+$/.test(first) && !unitNext) {
    const n = Number(first);
    if (n >= 1 && n <= 50) return { quantity: n, rest: tokens.slice(1).join(" ") };
  }

  const fold = soundFold(first);
  for (const [word, n] of Object.entries(QUANTITY_WORDS)) {
    if (unitNext) break;
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

/**
 * How many of the caller's IDENTIFYING words this dish accounts for.
 *
 * Identifying means: not noise, and not the category. "Pizza" tells you
 * nothing about which pizza — it is the word for the whole shelf — and a match
 * carried entirely by it is not an answer to anything. That is the whole fault
 * this exists for: the phonetic fold makes "pizza" and "PAZZA" the same word,
 * so on a menu with a pizza called Pazza, every caller who said "pizza" scored
 * it 1.00 and tied with the dish they had actually named.
 */
function specificHits(said: string, name: string, category?: string): number {
  const catWords = new Set(
    plain(category ?? "")
      .split(" ")
      .filter(Boolean)
      .map(singular),
  );
  const words = plain(said)
    .split(" ")
    .filter((t) => t && !NOISE.has(t) && !catWords.has(singular(t)));
  return words.filter((t) => scoreItem(t, name) > 0).length;
}

export interface GroupMatch<T> {
  group: ItemGroup<T>;
  score: number;
  /** They said the dish's name, and nothing else. */
  exact?: boolean;
  /** How many of the caller's identifying words — not noise, not the
   *  category — this dish accounts for. Breaks a tie on score. */
  specific?: number;
}

/**
 * Rank the menu's DISHES against what was heard, sizes set aside.
 *
 * This is the version the ordering flow should use. matchMenuItems still
 * exists for callers that genuinely want one entry per size.
 */
export function matchItemGroups<T extends { name: string; categoryName?: string }>(
  said: string,
  items: T[],
  opts: { limit?: number; floor?: number } = {},
): Array<GroupMatch<T>> {
  const floor = opts.floor ?? 0.5;
  const query = stripSizeWords(said) || plain(said);
  return groupBySize(items)
    .map((group) => {
      // "Coca-Cola 330ml" is two words of name and one of packaging; scoring
      // the packaging as a third of the dish is what kept "a coke" at 0.67.
      const base = stripSizeWords(group.base) || group.base;
      // People say the category out loud — "a pepperoni PIZZA" for an item the
      // menu just calls "Pepperoni", "a coke" for something filed under
      // Drinks. Scoring the name WITH its category lets that extra word help
      // instead of counting against them. It cannot inflate a tie: a query
      // that only matches the category word scores 0.5 and stays unconfident.
      const withCategory = group.variants[0]?.categoryName
        ? `${base} ${group.variants[0]!.categoryName}`
        : null;
      const score = Math.max(
        scoreItem(query, base),
        withCategory ? scoreItem(query, withCategory) : 0,
      );
      // Said the name, and nothing else. That is not a score to be compared
      // with other scores — it is an answer, and it must not be able to tie.
      //
      // Filler does not count as "something else". "A chips" is as exact as
      // "chips", and on a menu selling both CHIPS and FRIES — which the
      // synonym table treats as the same word — the difference between them
      // was the difference between an order and a question.
      const bare = (t: string) =>
        plain(t).split(" ").filter((w) => w && !NOISE.has(w)).join(" ");
      const exact = bare(query) === bare(base);
      // Which of the caller's words actually point at THIS dish, as opposed to
      // the shelf it sits on. Level scores are broken with this, so that
      // "a pepperoni pizza" is a pepperoni rather than a question.
      const specific = specificHits(query, base, group.variants[0]?.categoryName);
      return { group, score, exact, specific };
    })
    .filter((m) => m.score >= floor)
    .sort(
      (a, b) =>
        (a.exact === b.exact ? 0 : a.exact ? -1 : 1) ||
        b.score - a.score ||
        b.specific - a.specific,
    )
    .slice(0, opts.limit ?? 5);
}

/** Same bar as isConfident, over dishes rather than sizes. */
export function isConfidentGroup<T>(matches: Array<GroupMatch<T>>): boolean {
  const [best, second] = matches;
  if (!best || best.score < 0.75) return false;
  // One dish whose name they said exactly is decisive, whatever else scored
  // well. Only another exact match is a real question.
  if (best.exact) return !second?.exact;
  // Full coverage of a dish's name beats partial coverage of a longer one.
  // "chicken gyro wrap as a wrap" scored Chicken Gyros Wrap 1.00 against The
  // Furry Chicken Gyros Wrap 0.83 — a clear winner, refused because the gap
  // was 0.17 and the bar was 0.20. A menu with a "Monster" and a "Furry"
  // version of everything makes that gap permanent.
  if (best.score >= 1 && (!second || second.score < best.score)) return true;
  if (!second || best.score - second.score >= 0.2) return true;
  // Level on score, but one of them is picked out by the words the caller
  // used and the other is only there because they said the category out loud.
  // That is not a question worth asking, and asking it is exactly what "it
  // doesn't understand" sounds like from the other end of a phone.
  return (best.specific ?? 0) > (second.specific ?? 0);
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

/**
 * The caller's answer to a question with a known, short list of answers.
 *
 * This is a different problem from finding a dish on a menu, and the general
 * matcher gets it wrong in both directions. Asked "which wrap — gyros,
 * halloumi or souvlaki?", a caller says "gyros", never "gyros wrap" — but the
 * option is CALLED "Gyros Wrap", so half its words are missing and it scored
 * 0.50, under the bar, and the line asked again. The caller then repeats
 * themselves, is misheard identically, and concludes the thing is stupid.
 *
 * Two corrections, both only safe because the list is closed:
 *
 *   - The group's own name is not information. "Wrap" in "Gyros Wrap" is the
 *     question, not the answer, so it is not held against them for omitting it.
 *   - Half of a name nobody else shares is an answer. Across three options,
 *     "halloumi" can only mean one of them; it is only ambiguity that has to
 *     be asked about, and that is measured directly rather than guessed at
 *     with a threshold.
 *
 * "Diet Coke" against "Coke" is why the tie-break exists: both score a perfect
 * 1 for "diet coke" — one by covering its whole name — and the answer is the
 * one that accounts for more of what the caller actually said.
 */
export function matchOption<T extends { name: string }>(
  said: string,
  options: T[],
  groupName: string,
): { item: T; score: number } | null {
  const groupWords = new Set(plain(groupName).split(" ").filter(Boolean));
  const heard = plain(said).split(" ").filter(Boolean);
  if (!heard.length || !options.length) return null;

  const scored = options
    .map((item) => {
      // Scored both ways round: stripping helps "gyros" and would hurt a
      // caller who did say "gyros wrap", so neither reading is imposed.
      const stripped = plain(item.name)
        .split(" ")
        .filter((t) => t && !groupWords.has(t))
        .join(" ");
      const score = Math.max(
        scoreItem(said, item.name),
        stripped ? scoreItem(said, stripped) : 0,
      );
      // How much of what they SAID this accounts for — the general matcher
      // ignores this on purpose, and inside a closed list it is the tie-break.
      const covered =
        heard.filter((t) => scoreItem(t, item.name) > 0).length / heard.length;
      return { item, score, covered };
    })
    .sort((a, b) => b.score - a.score || b.covered - a.covered);

  const [best, second] = scored;
  if (!best || best.score < 0.5) return null;
  if (second && best.score - second.score < 0.2 && best.covered - second.covered < 0.3) {
    return null;
  }
  return { item: best.item, score: best.score };
}

/**
 * What they asked for, and how many, deciding which of those the leading
 * number was.
 *
 * "Four Meat" is a pizza. Reading its first word as a quantity left "meat",
 * which fits Small Meat, Meatballs and Meaty equally, and put FOUR of whichever
 * won the coin toss into the cart. "Two cokes" is the same shape of phrase and
 * genuinely means two — the difference is not in the grammar, it is in whether
 * the menu has something by that name.
 *
 * So both readings are tried against the actual menu and the better one wins,
 * with the quantity reading keeping ties: "two cokes" is far more often two
 * cokes than a dish called Two Cokes.
 */
export function matchWithQuantity<T extends { name: string; categoryName?: string }>(
  phrase: string,
  items: T[],
  opts: { limit?: number; floor?: number } = {},
): { quantity: number; matches: Array<GroupMatch<T>> } {
  const { quantity, rest } = splitQuantity(phrase);
  const asSaid = matchItemGroups(phrase, items, opts);
  if (quantity === 1 || !rest) return { quantity: 1, matches: asSaid };

  const stripped = matchItemGroups(rest, items, opts);
  const whole = asSaid[0];
  const part = stripped[0];
  const wholeWins =
    isConfidentGroup(asSaid) &&
    (!isConfidentGroup(stripped) ||
      (whole?.score ?? 0) > (part?.score ?? 0) ||
      ((whole?.score ?? 0) === (part?.score ?? 0) &&
        (whole?.specific ?? 0) > (part?.specific ?? 0)));

  return wholeWins
    ? { quantity: 1, matches: asSaid }
    : { quantity, matches: stripped };
}

/**
 * Several dishes said in one breath, with nothing between them.
 *
 * "Twelve inch pepperoni chips and garlic sauce" is three things. Splitting on
 * "and" finds two of them, and the first — "twelve inch pepperoni chips" —
 * is then scored as if it were the name of one dish. It fits Pepperoni,
 * Chips and Fries equally badly, so all of it was thrown away and the caller
 * got a garlic sauce.
 *
 * People do not say "and" between every item. They pause, and a pause does not
 * survive transcription. So when a phrase cannot be one dish, it is read the
 * way a person reads it: take the longest run of words from the front that IS
 * a dish, then start again from where that ended.
 *
 * Longest-first matters. "Twelve inch pepperoni" has to win over "twelve",
 * or the size becomes a quantity and the pizza becomes something else.
 */
/** Does this dish account for every word of the phrase that carries meaning? */
export function explains<T extends { name: string; categoryName?: string }>(
  phrase: string,
  group: ItemGroup<T>,
): boolean {
  const name = `${group.base} ${group.variants[0]?.categoryName ?? ""}`;
  // Sizes and quantities are not the dish's job to account for: "twelve inch
  // pepperoni" is a Pepperoni, and the twelve inches belong to nobody on a
  // menu that does not sell sizes.
  const rest = stripSizeWords(splitQuantity(phrase).rest || phrase);
  return rest
    .split(" ")
    .filter((t) => t && !NOISE.has(t))
    .every((t) => scoreItem(t, name) > 0);
}

export function segmentItems<T extends { name: string; categoryName?: string }>(
  said: string,
  items: T[],
  opts: { limit?: number; floor?: number; maxWords?: number } = {},
): { found: Array<{ quantity: number; match: GroupMatch<T>; phrase: string }>; leftovers: string[] } {
  const tokens = plain(said).split(" ").filter(Boolean);
  const maxWords = opts.maxWords ?? 6;
  const found: Array<{ quantity: number; match: GroupMatch<T>; phrase: string }> = [];
  const leftovers: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    let taken = 0;
    for (let len = Math.min(maxWords, tokens.length - i); len >= 1; len--) {
      const phrase = tokens.slice(i, i + len).join(" ");
      const { quantity, matches } = matchWithQuantity(phrase, items, opts);
      if (!isConfidentGroup(matches)) continue;
      // The dish has to EXPLAIN the words it is taking.
      //
      // Scoring deliberately ignores words the caller said that the dish does
      // not have — "can I get a large pepperoni pizza please" should not be
      // marked down for the please. That is right when the phrase is one dish
      // and disastrous when it might be three: "kebab pizza cheesy chips"
      // fits Cheesy Chips perfectly, ignores "kebab pizza", and swallows a
      // whole pizza on its way past. So a window is only taken if what is left
      // over is noise or a size.
      if (!explains(phrase, matches[0]!.group)) continue;
      found.push({ quantity, match: matches[0]!, phrase });
      taken = len;
      break;
    }
    if (taken) {
      i += taken;
      continue;
    }
    leftovers.push(tokens[i]!);
    i += 1;
  }
  return { found, leftovers };
}
