import { describe, expect, it } from "vitest";
import { tableBadgeLabel } from "./platform-badge";

// The board has to say which table a dine-in order belongs to. It used to,
// by accident: a QR round with no guest name took the TABLE's name as the
// customer name, so the row read "Table 4". Pay-at-the-table asks for a real
// name now, and the table vanished off the board with it.

describe("tableBadgeLabel", () => {
  it("names a bare number, so it can't read as a quantity", () => {
    expect(tableBadgeLabel("4")).toBe("Table 4");
    expect(tableBadgeLabel(" 12 ")).toBe("Table 12");
  });

  it("leaves anything the operator spelled out exactly as they wrote it", () => {
    // It's what's painted on the actual table — don't improve it.
    for (const name of ["Table 4", "T5", "Window 2", "Bar 1", "Terrace A"]) {
      expect(tableBadgeLabel(name)).toBe(name);
    }
  });

  it("is null for an order that has no table, so no chip renders", () => {
    expect(tableBadgeLabel(null)).toBeNull();
    expect(tableBadgeLabel(undefined)).toBeNull();
    expect(tableBadgeLabel("")).toBeNull();
    expect(tableBadgeLabel("   ")).toBeNull();
  });
});
