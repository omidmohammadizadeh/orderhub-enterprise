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

  let hits = 0;
  for (const nameToken of n) {
    const fold = soundFold(nameToken);
    const hit = q.some(
      (queryToken) =>
        queryToken === nameToken ||
        near(queryToken, nameToken) ||
        soundFold(queryToken) === fold ||
        near(soundFold(queryToken), fold),
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
