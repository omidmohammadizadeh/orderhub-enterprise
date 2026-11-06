import { describe, expect, it } from "vitest";
import {
  KEYBOARD_LANGUAGES,
  applyKey,
  keyboardLanguage,
  keypadFor,
  shiftedRows,
  wantsCapitals,
  type FieldDescription,
} from "./keyboard-layouts";

const field = (over: Partial<FieldDescription>): FieldDescription => ({
  tag: "input",
  type: "text",
  inputMode: "",
  hints: "",
  ...over,
});

describe("keypadFor", () => {
  it("gives a phone field the numpad, however it asks", () => {
    expect(keypadFor(field({ type: "tel" }))).toBe("tel");
    expect(keypadFor(field({ inputMode: "tel" }))).toBe("tel");
  });
  it("gives money fields digits with a point", () => {
    expect(keypadFor(field({ inputMode: "decimal" }))).toBe("decimal");
    expect(keypadFor(field({ type: "number" }))).toBe("decimal");
  });
  it("gives a numeric PIN digits only", () => {
    expect(keypadFor(field({ type: "password", inputMode: "numeric" }))).toBe("numeric");
  });
  it("knows email and falls back to letters", () => {
    expect(keypadFor(field({ type: "email" }))).toBe("email");
    expect(keypadFor(field({ type: "search" }))).toBe("text");
    expect(keypadFor(field({ tag: "textarea", type: "" }))).toBe("text");
  });
  it("spots a postcode field", () => {
    expect(wantsCapitals(field({ hints: "Postcode Postcode  " }))).toBe(true);
    expect(wantsCapitals(field({ hints: "Customer name" }))).toBe(false);
  });
});

describe("applyKey", () => {
  it("types at the caret", () => {
    expect(applyKey({ value: "ac", start: 1, end: 1 }, { kind: "insert", text: "b" })).toEqual({
      value: "abc",
      start: 2,
      end: 2,
    });
  });
  it("replaces a selection", () => {
    expect(applyKey({ value: "hello", start: 0, end: 5 }, { kind: "insert", text: "x" }).value).toBe("x");
  });
  it("backspaces one character, or the selection", () => {
    expect(applyKey({ value: "abc", start: 3, end: 3 }, { kind: "backspace" })).toEqual({ value: "ab", start: 2, end: 2 });
    expect(applyKey({ value: "abc", start: 0, end: 2 }, { kind: "backspace" }).value).toBe("c");
    expect(applyKey({ value: "abc", start: 0, end: 0 }, { kind: "backspace" }).value).toBe("abc");
  });
  it("deletes a whole emoji, not half of it", () => {
    expect(applyKey({ value: "a😀", start: 3, end: 3 }, { kind: "backspace" }).value).toBe("a");
  });
  it("respects maxLength", () => {
    expect(applyKey({ value: "1234", start: 4, end: 4 }, { kind: "insert", text: "5" }, 4).value).toBe("1234");
  });
});

describe("languages", () => {
  it("upper-cases Turkish the Turkish way", () => {
    const rows = shiftedRows(keyboardLanguage("tr")).flat();
    expect(rows).toContain("İ");
    expect(rows).toContain("I");
  });
  it("falls back to English for an unknown code", () => {
    expect(keyboardLanguage("xx").code).toBe("en");
  });
  it("has three letter rows per language, with shift rows to match", () => {
    for (const l of KEYBOARD_LANGUAGES) {
      expect(l.rows).toHaveLength(3);
      if (l.shiftRows) expect(l.shiftRows).toHaveLength(3);
    }
  });
});
