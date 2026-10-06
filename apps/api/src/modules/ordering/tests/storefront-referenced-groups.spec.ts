import { referencedModifierGroupIds } from "../ordering.service";

// The storefront used to load EVERY modifier group the brand owns. On a brand
// that has run menu imports that is thousands of rows, most of them other
// imports' groups and empty "__import_holding" ones, and a table QR scan
// waited 10 s for the menu. It now loads only what the served menu can open.
// This pins that set: miss one and a product opens with no options.

const menu = {
  categories: [
    {
      items: [
        {
          item: {
            id: "pizza",
            modifierGroupLinks: [
              { groupId: "toppings" },
              // An embedded copy (pre-hoist shape) counts too.
              { group: { id: "crust" } },
            ],
            productSkus: [
              { name: "10in", modifierGroups: ["size-10-extras"] },
              { name: "12in", modifierGroups: ["size-12-extras", "toppings"] },
            ],
          },
        },
        { item: { id: "coke", modifierGroupLinks: [], productSkus: [] } },
      ],
    },
    { items: [{ item: { id: "fries", modifierGroupLinks: [{ groupId: "dips" }] } }] },
  ],
};

describe("referencedModifierGroupIds", () => {
  it("collects item-linked and per-size groups, once each", () => {
    expect([...referencedModifierGroupIds(menu)].sort()).toEqual([
      "crust",
      "dips",
      "size-10-extras",
      "size-12-extras",
      "toppings",
    ]);
  });

  it("ignores junk in the JSON column rather than throwing", () => {
    const odd = {
      categories: [
        {
          items: [
            { item: { productSkus: [{ modifierGroups: [null, "", 7, "ok"] }, null] } },
            { item: { productSkus: "not-an-array" } },
            {},
          ],
        },
      ],
    };
    expect([...referencedModifierGroupIds(odd)]).toEqual(["ok"]);
  });

  it("is empty for no menu, so no catalogue query runs", () => {
    expect(referencedModifierGroupIds(null).size).toBe(0);
    expect(referencedModifierGroupIds({ categories: [] }).size).toBe(0);
  });
});
