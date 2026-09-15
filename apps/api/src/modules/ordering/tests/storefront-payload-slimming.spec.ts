import {
  hoistModifierGroups,
  stripInternalFields,
} from "../ordering.service";

// Every item used to carry a FULL copy of every modifier group it links. On
// Pizza Uno Pelton that was 24 distinct groups shipped 257 times — 1.7MB of a
// 3.2MB payload, re-downloaded by every customer, for data already present in
// brandModifierGroups. Links now carry groupId and the client resolves against
// that catalogue, the way multi-SKU products always have.

const group = (id: string, opts: string[] = []) => ({
  id,
  name: id,
  options: opts.map((o) => ({ id: o, name: o })),
});

const menuWith = (links: Array<{ itemId: string; groups: any[] }>) => ({
  categories: [
    {
      id: "cat",
      items: links.map((l) => ({
        itemId: l.itemId,
        item: {
          id: l.itemId,
          modifierGroupLinks: l.groups.map((g) => ({
            groupId: g.id,
            itemId: l.itemId,
            sortOrder: 0,
            group: g,
          })),
        },
      })),
    },
  ],
});

describe("hoistModifierGroups", () => {
  it("sends one copy of a group linked by many items", () => {
    const toppings = group("toppings", ["cheese", "ham"]);
    const menu = menuWith([
      { itemId: "p1", groups: [{ ...toppings }] },
      { itemId: "p2", groups: [{ ...toppings }] },
      { itemId: "p3", groups: [{ ...toppings }] },
    ]);
    const groups: any[] = [toppings];

    hoistModifierGroups(menu, groups);

    expect(groups.filter((g) => g.id === "toppings")).toHaveLength(1);
    for (const link of menu.categories[0]!.items) {
      for (const gl of link.item.modifierGroupLinks) {
        expect(gl.group).toBeUndefined();
        expect(gl.groupId).toBe("toppings");
      }
    }
  });

  // THE one that matters. brandModifierGroups is brand-scoped; a group owned
  // by another brand of the same tenant was only ever reachable through the
  // embedded copy. Strip it without merging and the product opens with NO
  // options — still orderable, at the base price.
  it("merges a linked group the brand catalogue does not already have", () => {
    const foreign = group("from-another-brand", ["a", "b"]);
    const menu = menuWith([{ itemId: "p1", groups: [foreign] }]);
    const groups: any[] = [group("own-group")];

    hoistModifierGroups(menu, groups);

    const merged = groups.find((g) => g.id === "from-another-brand");
    expect(merged).toBeDefined();
    expect(merged.options.map((o: any) => o.id)).toEqual(["a", "b"]);
  });

  it("keeps the catalogue's own copy rather than overwriting it", () => {
    // The catalogue copy has been through foldArrayAttachedOptions; the
    // embedded one may be a different instance. First one in wins.
    const folded = group("g", ["one", "two", "added-by-fold"]);
    const menu = menuWith([{ itemId: "p1", groups: [group("g", ["one", "two"])] }]);
    const groups: any[] = [folded];

    hoistModifierGroups(menu, groups);

    expect(groups).toHaveLength(1);
    expect(groups[0].options).toHaveLength(3);
  });

  it("leaves a link that never had a group alone", () => {
    const menu: any = {
      categories: [
        {
          items: [
            { item: { id: "p1", modifierGroupLinks: [{ groupId: "g1", sortOrder: 0 }] } },
          ],
        },
      ],
    };
    const groups: any[] = [group("g1")];
    expect(() => hoistModifierGroups(menu, groups)).not.toThrow();
    expect(groups).toHaveLength(1);
  });

  it("survives a menu with no categories or items", () => {
    const groups: any[] = [];
    expect(() => hoistModifierGroups(null, groups)).not.toThrow();
    expect(() => hoistModifierGroups({}, groups)).not.toThrow();
    expect(() => hoistModifierGroups({ categories: [{}] }, groups)).not.toThrow();
  });
});

describe("stripInternalFields", () => {
  it("drops publish-pipeline bookkeeping the browser never reads", () => {
    const node: any = {
      id: "g",
      name: "Toppings",
      syncHash: "abc",
      syncStatus: "SYNCED",
      lastSyncedAt: "2026-01-01",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      menuIds: ["m1"],
      modifierGroupIds: ["g2"],
      rawModifierIds: ["r"],
    };
    stripInternalFields(node);
    expect(Object.keys(node).sort()).toEqual(["id", "name"]);
  });

  // These reach the price the customer pays, or the options they are shown.
  // Removing any of them is a wrong order, not a smaller payload.
  it("KEEPS everything that affects price or what is offered", () => {
    const option: any = {
      id: "o1",
      name: "Large",
      nestedGroupId: "meal-deal",
      plu: "1234",
      priceAdjustment: "2.50",
      pricesBySize: { large: "3.00" },
      platformPricingOverrides: { DELIVEROO: "3.50" },
      deliveryTax: 20,
      eatInTax: 20,
      takeawayTax: 0,
      isAvailable: true,
      createdAt: "2026-01-01",
    };
    stripInternalFields(option);
    expect(option).toMatchObject({
      nestedGroupId: "meal-deal",
      plu: "1234",
      priceAdjustment: "2.50",
      pricesBySize: { large: "3.00" },
      platformPricingOverrides: { DELIVEROO: "3.50" },
      deliveryTax: 20,
      eatInTax: 20,
      takeawayTax: 0,
      isAvailable: true,
    });
    expect(option.createdAt).toBeUndefined();
  });

  it("reaches nested options, not just the top level", () => {
    const menu: any = {
      createdAt: "x",
      categories: [
        { createdAt: "x", items: [{ item: { id: "i", createdAt: "x", syncHash: "h" } }] },
      ],
    };
    stripInternalFields(menu);
    expect(menu.createdAt).toBeUndefined();
    expect(menu.categories[0].createdAt).toBeUndefined();
    expect(menu.categories[0].items[0].item.createdAt).toBeUndefined();
    expect(menu.categories[0].items[0].item.syncHash).toBeUndefined();
    expect(menu.categories[0].items[0].item.id).toBe("i");
  });

  it("handles nulls and arrays without throwing", () => {
    expect(() => stripInternalFields(null)).not.toThrow();
    expect(() => stripInternalFields([null, { createdAt: "x" }])).not.toThrow();
  });
});

// The end-to-end property the change rests on: what the customer can pick
// must be identical before and after. This mirrors how the modal resolves —
// embedded group if present, otherwise the catalogue by id.
describe("what the customer is offered does not change", () => {
  it("resolves every item to the same groups and options", () => {
    const shared = group("shared", ["s1", "s2"]);
    const foreign = group("foreign", ["f1"]);
    const menu = menuWith([
      { itemId: "p1", groups: [{ ...shared }, { ...foreign }] },
      { itemId: "p2", groups: [{ ...shared }] },
    ]);
    const groups: any[] = [shared];

    const before = resolve(menu, groups);
    hoistModifierGroups(menu, groups);
    const after = resolve(menu, groups);

    expect(after).toEqual(before);
    expect(after.p1).toEqual([
      ["shared", ["s1", "s2"]],
      ["foreign", ["f1"]],
    ]);
  });

  /** Mirrors ModifierSelectionModal: embedded group, else catalogue by id. */
  function resolve(menu: any, groups: any[]) {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const out: Record<string, Array<[string, string[]]>> = {};
    for (const cat of menu.categories ?? []) {
      for (const link of cat.items ?? []) {
        const item = link.item;
        out[item.id] = (item.modifierGroupLinks ?? [])
          .map((gl: any) => gl.group ?? byId.get(gl.groupId))
          .filter(Boolean)
          .map((g: any) => [g.id, (g.options ?? []).map((o: any) => o.id)]);
      }
    }
    return out;
  }
});
