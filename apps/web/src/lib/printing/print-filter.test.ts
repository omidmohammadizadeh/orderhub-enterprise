import { describe, expect, it } from "vitest";
import {
  buildFilterCatalog,
  readPrintFilter,
  splitLinesForPrinters,
  stationPayload,
} from "./print-filter";

const catalog = buildFilterCatalog({
  categories: [
    { name: "Drinks", itemCount: 2 },
    { name: "Grill", itemCount: 1 },
    { name: "Sides", itemCount: 1 },
  ],
  items: [
    { id: "coke", name: "Coke", categories: ["Drinks"] },
    { id: "ayran", name: "Ayran", categories: ["Drinks"] },
    { id: "kebab", name: "Lamb Kebab", categories: ["Grill"] },
    { id: "chips", name: "Chips", categories: ["Sides"] },
  ],
});

const printer = (id: string, printFilter?: unknown) => ({
  id,
  defaults: printFilter === undefined ? {} : { printFilter },
});

const lines = [
  { menuItemId: "kebab", name: "Lamb Kebab" },
  { menuItemId: "coke", name: "Coke" },
  { menuItemId: "chips", name: "Chips" },
];

describe("readPrintFilter", () => {
  it("treats a printer with no filter, or an empty one, as print-everything", () => {
    expect(readPrintFilter(printer("a"))).toBeNull();
    expect(readPrintFilter(printer("a", null))).toBeNull();
    expect(
      readPrintFilter(printer("a", { categories: [], items: [], catchAll: false })),
    ).toBeNull();
  });
});

describe("splitLinesForPrinters", () => {
  it("leaves every printer alone when none has a filter", () => {
    expect(splitLinesForPrinters(lines, [printer("a"), printer("b")], catalog).size).toBe(0);
  });

  it("sends drinks to the bar and grill to the grill", () => {
    const split = splitLinesForPrinters(
      lines,
      [
        printer("bar", { categories: ["drinks"] }),
        printer("grill", { categories: ["Grill"], catchAll: true }),
      ],
      catalog,
    );
    expect(split.get("bar")).toEqual([1]);
    // Chips belong to nobody, so the catch-all grill printer takes them.
    expect(split.get("grill")).toEqual([0, 2]);
  });

  it("never drops a line: with no catch-all and no full printer, unclaimed lines go to every filtered printer", () => {
    const split = splitLinesForPrinters(
      lines,
      [printer("bar", { categories: ["Drinks"] }), printer("grill", { categories: ["Grill"] })],
      catalog,
    );
    expect(split.get("bar")).toEqual([1, 2]);
    expect(split.get("grill")).toEqual([0, 2]);
  });

  it("leaves unclaimed lines to an unfiltered printer that prints the full order", () => {
    const split = splitLinesForPrinters(
      lines,
      [printer("till"), printer("bar", { categories: ["Drinks"] })],
      catalog,
    );
    expect(split.has("till")).toBe(false);
    expect(split.get("bar")).toEqual([1]);
  });

  it("an order with nothing for a printer gives it an empty list (skip)", () => {
    const split = splitLinesForPrinters(
      [lines[0]],
      [printer("till"), printer("bar", { categories: ["Drinks"] })],
      catalog,
    );
    expect(split.get("bar")).toEqual([]);
  });

  it("matches marketplace lines with no menuItemId by name, and single items", () => {
    const split = splitLinesForPrinters(
      [{ name: "AYRAN" }, { name: "Lamb Kebab" }],
      [printer("till"), printer("bar", { items: ["Lamb Kebab"], categories: ["Drinks"] })],
      catalog,
    );
    expect(split.get("bar")).toEqual([0, 1]);
  });

  it("prints everything on filtered printers when the menu can't be loaded", () => {
    const split = splitLinesForPrinters(
      lines,
      [printer("bar", { categories: ["Drinks"] })],
      null,
    );
    expect(split.get("bar")).toEqual([0, 1, 2]);
  });
});

describe("stationPayload", () => {
  it("keeps only its lines and strips money and the QR", () => {
    const out = stationPayload(
      {
        banner: null,
        items: [
          { name: "Lamb Kebab", totalPrice: 9, modifiers: [{ name: "Chilli", price: 0.5 }] },
          { name: "Coke", totalPrice: 2, modifiers: [] },
        ],
        subtotal: 11,
        total: 11,
        paymentLabel: "CARD PAID",
        qrData: "https://x",
      },
      [1],
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0].name).toBe("Coke");
    expect(out.items[0].totalPrice).toBeUndefined();
    expect(out.total).toBeUndefined();
    expect(out.subtotal).toBeUndefined();
    expect(out.paymentLabel).toBeNull();
    expect(out.qrData).toBeNull();
    expect(out.banner).toBe("PART ORDER - 1 OF 2 ITEMS");
  });

  it("keeps an event banner such as ORDER CANCELLED", () => {
    const out = stationPayload(
      { banner: "*** ORDER CANCELLED ***", items: [{ name: "a" }, { name: "b" }] },
      [0],
    );
    expect(out.banner).toBe("*** ORDER CANCELLED ***");
  });
});
