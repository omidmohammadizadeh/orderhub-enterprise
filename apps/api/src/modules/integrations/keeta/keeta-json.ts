// Phase KT — JSON that survives Keeta's 64-bit ids.
//
// Keeta ids are Java longs. An orderViewId like 756823555555859 fits in a JS
// number, but they are not bounded by 2^53 and nothing in the docs says they
// will stay under it — userId is already 10000011133443, and the next digit
// is where JSON.parse starts silently rounding. A rounded orderViewId is a
// DIFFERENT order: confirm would 404, or worse, act on someone else's.
//
// So Keeta JSON is never parsed with a bare JSON.parse. Any integer literal
// long enough to be at risk is turned into a string first, and ids are
// carried as strings from then on. Going back out, those ids must be sent as
// JSON NUMBERS (Keeta's schema types them int64), which JSON.stringify cannot
// do for a string — hence KeetaInt, a marker the serialiser prints bare.

/** Integers with this many digits or more are kept as strings. 2^53 has 16. */
const UNSAFE_DIGITS = 16;

/**
 * JSON.parse, except integers of 16+ digits arrive as strings.
 *
 * A small scanner rather than a regex: a regex cannot tell a number from the
 * same digits inside a string value, and Keeta put whole JSON documents inside
 * string fields (`message`, `addressStruct`), so that case is the common one.
 */
export function parseKeetaJson<T = any>(text: string): T {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy a string literal verbatim, honouring escapes.
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === '"') break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + (ch === "-" ? 1 : 0);
      while (j < n && text[j]! >= "0" && text[j]! <= "9") j++;
      const isInteger = !(j < n && (text[j] === "." || text[j] === "e" || text[j] === "E"));
      const digits = j - i - (ch === "-" ? 1 : 0);
      if (isInteger && digits >= UNSAFE_DIGITS) {
        out += `"${text.slice(i, j)}"`;
        i = j;
        continue;
      }
      // Not at risk (or not an integer): copy through the whole number token.
      let k = j;
      while (k < n && /[0-9eE.+\-]/.test(text[k]!)) k++;
      out += text.slice(i, k);
      i = k;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out) as T;
}

/** An integer to send as a bare JSON number, however many digits it has. */
export class KeetaInt {
  readonly digits: string;
  constructor(value: string | number | bigint) {
    const s = String(value).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`Not an integer id: "${s}"`);
    this.digits = s;
  }
  toString(): string {
    return this.digits;
  }
}

/** Shorthand used wherever an id goes back to Keeta. */
export const kInt = (v: string | number | bigint) => new KeetaInt(v);

/**
 * Compact JSON, with KeetaInt printed as a bare number and keys in insertion
 * order.
 *
 * Insertion order matters twice over: the same string is what we sign for a
 * nested object ("use the original JSON string as-is", their FAQ 4.3) and what
 * goes on the wire, so the two can never disagree about key order or spacing.
 */
export function stringifyKeeta(value: unknown): string {
  if (value instanceof KeetaInt) return value.digits;
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stringifyKeeta(v)).join(",")}]`;
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Dropped, as JSON.stringify drops it — an absent key is not a null one.
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${stringifyKeeta(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/** An id that may have arrived as a number or (when long) a string. */
export function keetaId(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof KeetaInt) return v.digits;
  const s = String(v).trim();
  return s || null;
}
