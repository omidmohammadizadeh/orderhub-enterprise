import { buildRepeatLines, indexMenuItems } from "@orderhub/shared";

// "The usual" — the caller popup's repeat, which reached a real shop twice as
// an EMPTY BASKET. Both times a shape mistake nobody could see from the code,
// so the rules live in a pure function now and are pinned here.

const MENU = [
  {
    id: "cat1",
    // A category holds LINKS. `link.item` is the product. Indexing this by
    // `link.id` was mistake one, and made every line look unavailable.
    items: [
      {
        id: "link1",
        item: {
          id: "item_pizza",
          name: "VEGETARIAN",
          basePrice: 9,
          plu: "P1",
          hasMultipleSkus: true,
          productSkus: [
            { name: '10"', plu: "P1-10", price: 13 },
            { name: '12"', plu: "P1-12", price: 17 },
          ],
        },
      },
      {
        id: "link2",
        item: { id: "item_chips", name: "CHIPS", basePrice: 3.5, plu: "C1" },
      },
    ],
  },
];

const liveItems = () => indexMenuItems(MENU);

describe("indexMenuItems", () => {
  it("keys on the PRODUCT id, not the link id", () => {
    const map = liveItems();
    expect(map.get("item_pizza")?.name).toBe("VEGETARIAN");
    expect(map.get("link1")).toBeUndefined();
  });

  it("tolerates a bare item list too", () => {
    const map = indexMenuItems([{ id: "c", items: [{ id: "item_x", name: "X", basePrice: 1 }] }]);
    expect(map.get("item_x")?.name).toBe("X");
  });

  it("survives a menu with nothing in it", () => {
    expect(indexMenuItems(null).size).toBe(0);
    expect(indexMenuItems([{ id: "c" }]).size).toBe(0);
  });
});

describe("buildRepeatLines", () => {
  it("re-prices an unsized item from today's menu", () => {
    const r = buildRepeatLines(
      [{ menuItemId: "item_chips", name: "CHIPS", quantity: 2, unitPrice: 3 }],
      liveItems(),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ unitPrice: 3.5, quantity: 2, plu: "C1" });
    expect(r.repriced).toEqual(["CHIPS"]);
  });

  it("prices a sized item by its SIZE when the size was recorded", () => {
    const r = buildRepeatLines(
      [
        {
          menuItemId: "item_pizza",
          name: 'VEGETARIAN (12")',
          quantity: 1,
          unitPrice: 15,
          metadata: { sku: "P1-12" },
        },
      ],
      liveItems(),
    );
    // 17, the 12" price — NOT 9, the product's base price, which is what
    // charging by basePrice would have taken off the customer.
    expect(r.lines[0].unitPrice).toBe(17);
    expect(r.lines[0].plu).toBe("P1-12");
  });

  it("finds the size in the printed name when nothing recorded it", () => {
    // Every order placed before the size was stored on the line looks like
    // this, which is why dropping these lines emptied the basket.
    const r = buildRepeatLines(
      [
        {
          menuItemId: "item_pizza",
          name: 'VEGETARIAN (10", stuffed crust, +peppers)',
          quantity: 1,
          unitPrice: 13,
        },
      ],
      liveItems(),
    );
    expect(r.lines[0].unitPrice).toBe(13);
    expect(r.lines[0].plu).toBe("P1-10");
    expect(r.kept).toEqual([]);
  });

  it("keeps an unidentifiable size at what they paid, and says so", () => {
    const r = buildRepeatLines(
      [{ menuItemId: "item_pizza", name: "VEGETARIAN", quantity: 1, unitPrice: 13 }],
      liveItems(),
    );
    // Never dropped, never silently re-priced to the base price.
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].unitPrice).toBe(13);
    expect(r.kept).toEqual(["VEGETARIAN"]);
    expect(r.repriced).toEqual([]);
  });

  it("drops a line ONLY when the shop can't make it any more", () => {
    const r = buildRepeatLines(
      [
        { menuItemId: "item_deleted", name: "OLD SPECIAL", quantity: 1, unitPrice: 8 },
        { menuItemId: "item_chips", name: "CHIPS", quantity: 1, unitPrice: 3.5 },
      ],
      liveItems(),
    );
    expect(r.gone).toEqual(["OLD SPECIAL"]);
    expect(r.lines.map((l) => l.displayName)).toEqual(["CHIPS"]);
  });

  it("drops a line with no menu item id — it can't be ordered", () => {
    const r = buildRepeatLines(
      [{ menuItemId: null, name: "MYSTERY", quantity: 1, unitPrice: 5 }],
      liveItems(),
    );
    expect(r.lines).toHaveLength(0);
    expect(r.gone).toEqual(["MYSTERY"]);
  });

  it("carries modifiers at their recorded price", () => {
    const r = buildRepeatLines(
      [
        {
          menuItemId: "item_chips",
          name: "CHIPS",
          quantity: 1,
          unitPrice: 3.5,
          modifiers: [{ name: "Garlic sauce", price: "0.80" }],
        },
      ],
      liveItems(),
    );
    expect(r.lines[0].modifiers).toEqual([{ name: "Garlic sauce", price: 0.8 }]);
  });

  it("says nothing changed when nothing changed", () => {
    const r = buildRepeatLines(
      [{ menuItemId: "item_chips", name: "CHIPS", quantity: 1, unitPrice: 3.5 }],
      liveItems(),
    );
    expect(r.repriced).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(r.gone).toEqual([]);
  });

  it("returns an empty result for an order with no items", () => {
    expect(buildRepeatLines([], liveItems()).lines).toEqual([]);
  });
});
