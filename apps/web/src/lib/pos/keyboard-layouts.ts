// The till's own on-screen keyboard: the layouts, and the editing rules.
//
// Kept apart from the component so they can be tested without a DOM: which
// keypad a field gets, and what a key press does to its text, are the parts
// that go wrong quietly (a phone field showing letters, a backspace eating
// the wrong character).

export type KeyboardLanguage = {
  code: string;
  /** Shown on the space bar and in settings, in its own script. */
  name: string;
  dir: "ltr" | "rtl";
  /** Three letter rows. The number row and the bottom row are shared. */
  rows: string[][];
  /**
   * Rows shown with Shift. Omitted for scripts with upper case, which use
   * toLocaleUpperCase (Turkish i → İ needs the locale).
   */
  shiftRows?: string[][];
};

const split = (row: string) => row.split(" ");

export const KEYBOARD_LANGUAGES: KeyboardLanguage[] = [
  {
    code: "en",
    name: "English",
    dir: "ltr",
    rows: [split("q w e r t y u i o p"), split("a s d f g h j k l"), split("z x c v b n m")],
  },
  {
    code: "ar",
    name: "العربية",
    dir: "rtl",
    rows: [
      split("ض ص ث ق ف غ ع ه خ ح ج"),
      split("ش س ي ب ل ا ت ن م ك ط"),
      split("ذ ء ئ ؤ ر ى ة و ز ظ د"),
    ],
    shiftRows: [
      split("ض ص ث ق ف غ ع ه خ ح ج"),
      split("ش س ي ب ل أ إ آ م ك ط"),
      split("ذ ء ئ ؤ ر لا ى ة و ز ظ"),
    ],
  },
  {
    code: "fa",
    name: "فارسی",
    dir: "rtl",
    rows: [
      split("ض ص ث ق ف غ ع ه خ ح ج چ"),
      split("ش س ی ب ل ا ت ن م ک گ"),
      split("ظ ط ز ر ذ د پ و"),
    ],
    shiftRows: [
      split("ض ص ث ق ف غ ع ه خ ح ج چ"),
      split("ش س ی ب ل آ ت ن م ک گ"),
      split("ظ ط ژ ر ذ د ئ و"),
    ],
  },
  {
    code: "tr",
    name: "Türkçe",
    dir: "ltr",
    rows: [
      split("q w e r t y u ı o p ğ ü"),
      split("a s d f g h j k l ş i"),
      split("z x c v b n m ö ç"),
    ],
  },
];

export const DEFAULT_KEYBOARD_LANGUAGES = ["en"];

export function keyboardLanguage(code: string | undefined): KeyboardLanguage {
  return KEYBOARD_LANGUAGES.find((l) => l.code === code) ?? KEYBOARD_LANGUAGES[0]!;
}

export const NUMBER_ROW = split("1 2 3 4 5 6 7 8 9 0");

export const SYMBOL_ROWS = [
  split("@ # £ $ % & - + ( )"),
  split("* \" ' : ; ! ? / ="),
  split("_ € , . ~ < >"),
];

/** Shift rows for a language: its own, or its letters in upper case. */
export function shiftedRows(lang: KeyboardLanguage): string[][] {
  if (lang.shiftRows) return lang.shiftRows;
  return lang.rows.map((row) => row.map((k) => k.toLocaleUpperCase(lang.code)));
}

/** Whether Shift means anything for this language. */
export function hasShift(lang: KeyboardLanguage): boolean {
  return lang.dir === "ltr" || !!lang.shiftRows;
}

// ── Which keypad a field gets ──────────────────────────────────────────────

export type KeypadKind = "text" | "email" | "numeric" | "decimal" | "tel";

export type FieldDescription = {
  tag: "input" | "textarea";
  type: string;
  /** The field's own inputmode, before the keyboard replaced it with "none". */
  inputMode: string;
  /** aria-label, placeholder, name and autocomplete run together. */
  hints: string;
};

/** Input types that aren't typed into, so they keep their own picker. */
const NOT_TYPED = new Set([
  "checkbox",
  "radio",
  "range",
  "file",
  "color",
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

export function isTypedField(tag: string, type: string): boolean {
  if (tag === "textarea") return true;
  return tag === "input" && !NOT_TYPED.has(type);
}

export function keypadFor(field: FieldDescription): KeypadKind {
  const mode = field.inputMode;
  if (mode === "numeric") return "numeric";
  if (mode === "decimal") return "decimal";
  if (mode === "tel" || field.type === "tel") return "tel";
  if (field.type === "number") return "decimal";
  if (mode === "email" || field.type === "email") return "email";
  return "text";
}

/** Postcodes are typed in capitals; the keyboard starts with caps lock on. */
export function wantsCapitals(field: FieldDescription): boolean {
  return /post\s?code|postal|zip/i.test(field.hints);
}

// ── What a key does to the text ────────────────────────────────────────────

export type TextState = { value: string; start: number; end: number };

export type KeyAction = { kind: "insert"; text: string } | { kind: "backspace" };

/**
 * The text after a key press, and where the caret goes. A selection is
 * replaced (or deleted), as on any keyboard. `maxLength` < 0 means no limit;
 * a press that would pass the limit changes nothing.
 */
export function applyKey(state: TextState, action: KeyAction, maxLength = -1): TextState {
  const { value } = state;
  const start = Math.max(0, Math.min(state.start, value.length));
  const end = Math.max(start, Math.min(state.end, value.length));

  if (action.kind === "backspace") {
    if (start !== end) return { value: value.slice(0, start) + value.slice(end), start, end: start };
    if (start === 0) return { value, start, end: start };
    // Step back over a whole emoji or other surrogate pair, not half of one.
    const cut = start - previousCharLength(value, start);
    return { value: value.slice(0, cut) + value.slice(start), start: cut, end: cut };
  }

  const next = value.slice(0, start) + action.text + value.slice(end);
  if (maxLength >= 0 && next.length > maxLength) return { value, start, end };
  const caret = start + action.text.length;
  return { value: next, start: caret, end: caret };
}

function previousCharLength(value: string, index: number): number {
  const code = value.charCodeAt(index - 1);
  return index >= 2 && code >= 0xdc00 && code <= 0xdfff ? 2 : 1;
}
