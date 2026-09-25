// Renaming what a diner reads on a card machine, in bulk.
//
// "Table TABEL 2" reached a customer-facing terminal. The fix is a find and
// replace over live data, which is exactly the kind of thing that quietly
// mangles a name nobody was complaining about — so the matching is pinned.

import { fixTabel } from "../tidy-customer-facing-names";

describe("fixTabel", () => {
  it("keeps the case the shop typed", () => {
    expect(fixTabel("TABEL 2")).toBe("TABLE 2");
    expect(fixTabel("Tabel 2")).toBe("Table 2");
    expect(fixTabel("tabel 2")).toBe("table 2");
  });

  it("leaves a correctly spelt name alone", () => {
    expect(fixTabel("TABLE 2")).toBe("TABLE 2");
    expect(fixTabel("Window seat")).toBe("Window seat");
  });

  it("only matches the whole word", () => {
    // A shop could genuinely have these; neither is the typo.
    expect(fixTabel("TABELLA")).toBe("TABELLA");
    expect(fixTabel("Mistabel")).toBe("Mistabel");
  });

  it("fixes it wherever it sits in the name", () => {
    expect(fixTabel("Bar tabel 3")).toBe("Bar table 3");
    expect(fixTabel("TABEL 1 (window)")).toBe("TABLE 1 (window)");
  });
});
