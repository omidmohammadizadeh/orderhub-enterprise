// What a diner reads at the top of the bill on the card machine.
//
// We prefix a table's name with "Table", which is right for a shop whose
// tables are called "3" or "Window seat" and wrong for one whose tables are
// already called "TABLE 3" — that shop's customers got "Table TABLE 3".
// (Hidden until 2026-09-25, when the names were corrected from "TABEL".)

import { tableLabel } from "../dojo/dojo-epos.service";

describe("tableLabel", () => {
  it("doesn't repeat a name that already says table", () => {
    expect(tableLabel("TABLE 3")).toBe("TABLE 3");
    expect(tableLabel("Table 3")).toBe("Table 3");
    expect(tableLabel("table 3")).toBe("table 3");
    // Shops abbreviate on a small screen.
    expect(tableLabel("Tab 3")).toBe("Tab 3");
  });

  it("adds it when the name is just a number", () => {
    expect(tableLabel("3")).toBe("Table 3");
    expect(tableLabel("A12")).toBe("Table A12");
  });

  it("adds it to a named table, which needs the word to make sense", () => {
    expect(tableLabel("Window seat")).toBe("Table Window seat");
  });

  it("isn't fooled by a name that merely starts with those letters", () => {
    expect(tableLabel("Tablet bar")).toBe("Table Tablet bar");
  });

  it("tidies stray whitespace rather than prefixing it", () => {
    expect(tableLabel("  TABLE 3 ")).toBe("TABLE 3");
    expect(tableLabel(" 3 ")).toBe("Table 3");
  });
});
