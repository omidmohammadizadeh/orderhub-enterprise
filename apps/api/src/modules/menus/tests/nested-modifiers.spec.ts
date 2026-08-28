import {
  buildModifierTree,
  collectSelectedModifiers,
  findUnmetRequirements,
  toggleModifierSelection,
  adjustModifierQuantity,
  indexGroups,
  selectionKey,
  hasNestedGroups,
  toOrderLineModifier,
  modifierIndent,
  formatModifierPath,
  calculateCartItem,
  flattenModifierSteps,
  isStepSatisfied,
  shouldAutoAdvance,
  type NestableGroup,
} from "@orderhub/shared";

// ──────────────────────────────────────────────────────────────────────────
// Phase BN — nested modifier groups
//
// The real shape, from The Grill Stop's Big Boss Burger:
//
//   Big Boss Burger  £9.99
//   └── Make It a Meal
//       └── Make It a Meal  +£3.99
//           ├── Choose Side (required, pick one)
//           │   ├── Fries
//           │   │   └── Dip (required, pick one) → Garlic Mayo +£0.50
//           │   └── Waffle Fries +£1.00
//           └── Choose Drink (required, pick one) → Coke
//
// These tests are the contract between the till, the storefront and the
// kiosk. All three walk this code, so a divergence here is a mispriced
// order on one surface and not the other.
// ──────────────────────────────────────────────────────────────────────────

const opt = (id: string, name: string, price = 0, nested?: string[]) => ({
  id,
  name,
  priceAdjustment: price,
  ...(nested ? { nestedGroupIds: nested } : {}),
});

function catalog(): NestableGroup[] {
  return [
    {
      id: "g-meal",
      name: "Make It a Meal",
      selectionType: "VARIANT",
      minSelections: 0,
      maxSelections: 1,
      options: [opt("o-meal", "Make It a Meal", 3.99, ["g-side", "g-drink"])],
    },
    {
      id: "g-side",
      name: "Choose Side",
      selectionType: "VARIANT",
      minSelections: 1,
      maxSelections: 1,
      options: [
        opt("o-fries", "Fries", 0, ["g-dip"]),
        opt("o-waffle", "Waffle Fries", 1.0),
      ],
    },
    {
      id: "g-drink",
      name: "Choose Drink",
      selectionType: "VARIANT",
      minSelections: 1,
      maxSelections: 1,
      options: [opt("o-coke", "Coke")],
    },
    {
      id: "g-dip",
      name: "Dip",
      selectionType: "VARIANT",
      minSelections: 1,
      maxSelections: 1,
      options: [opt("o-mayo", "Garlic Mayo", 0.5)],
    },
  ];
}

const ROOTS = ["g-meal"];

function tree(selections: Record<string, string[]>) {
  const all = catalog();
  return buildModifierTree({
    rootGroups: all.filter((g) => ROOTS.includes(g.id)),
    groupsById: indexGroups(all),
    selections,
  });
}

/** The fully-answered meal: fries with garlic mayo, and a coke. */
const FULL_MEAL = {
  [selectionKey([], "g-meal")]: ["o-meal"],
  [selectionKey(["o-meal"], "g-side")]: ["o-fries"],
  [selectionKey(["o-meal"], "g-drink")]: ["o-coke"],
  [selectionKey(["o-meal", "o-fries"], "g-dip")]: ["o-mayo"],
};

describe("nested modifiers — the tree", () => {
  it("shows only the top-level group until the parent is picked", () => {
    const nodes = tree({});
    expect(nodes.map((n) => n.group.id)).toEqual(["g-meal"]);
    expect(nodes[0].options[0].children).toEqual([]);
  });

  it("opens the nested groups when the parent option is selected, in order", () => {
    const nodes = tree({ [selectionKey([], "g-meal")]: ["o-meal"] });
    const children = nodes[0].options[0].children;
    // Side before drink — the order the payload gave us.
    expect(children.map((c) => c.group.id)).toEqual(["g-side", "g-drink"]);
  });

  it("goes a second level deep", () => {
    const nodes = tree(FULL_MEAL);
    const side = nodes[0].options[0].children[0];
    const fries = side.options.find((o) => o.option.id === "o-fries")!;
    expect(fries.children.map((c) => c.group.id)).toEqual(["g-dip"]);
  });

  it("closes the whole subtree when the parent is deselected", () => {
    // The bug this guards: a £3.99 meal deselected but its dip still priced.
    const nodes = tree({ ...FULL_MEAL, [selectionKey([], "g-meal")]: [] });
    expect(nodes[0].options[0].children).toEqual([]);
    expect(collectSelectedModifiers(nodes)).toEqual([]);
  });

  it("keeps a group nested under two different options independent", () => {
    // "Dip" under Fries and under Waffle Fries is ONE group row. Keyed by
    // group id alone, ticking a dip under one would tick it under both.
    const all = catalog();
    all.find((g) => g.id === "g-side")!.options = [
      opt("o-fries", "Fries", 0, ["g-dip"]),
      opt("o-waffle", "Waffle Fries", 1.0, ["g-dip"]),
    ];
    all.find((g) => g.id === "g-side")!.selectionType = "ADDON";
    all.find((g) => g.id === "g-side")!.maxSelections = 2;

    const nodes = buildModifierTree({
      rootGroups: all.filter((g) => ROOTS.includes(g.id)),
      groupsById: indexGroups(all),
      selections: {
        [selectionKey([], "g-meal")]: ["o-meal"],
        [selectionKey(["o-meal"], "g-side")]: ["o-fries", "o-waffle"],
        [selectionKey(["o-meal", "o-fries"], "g-dip")]: ["o-mayo"],
      },
    });

    const side = nodes[0].options[0].children[0];
    const fries = side.options.find((o) => o.option.id === "o-fries")!;
    const waffle = side.options.find((o) => o.option.id === "o-waffle")!;
    expect(fries.children[0].options[0].selected).toBe(true);
    expect(waffle.children[0].options[0].selected).toBe(false);
  });

  it("survives a group nested under its own descendant", () => {
    // Nothing in the schema forbids a cycle, and an unguarded walk would
    // never return. A hand-edited catalog must not hang the till.
    const all = catalog();
    all.find((g) => g.id === "g-dip")!.options = [
      opt("o-mayo", "Garlic Mayo", 0.5, ["g-meal"]),
    ];
    expect(() =>
      buildModifierTree({
        rootGroups: all.filter((g) => ROOTS.includes(g.id)),
        groupsById: indexGroups(all),
        selections: FULL_MEAL,
      }),
    ).not.toThrow();
  });

  it("stops at the depth cap", () => {
    const nodes = buildModifierTree({
      rootGroups: catalog().filter((g) => ROOTS.includes(g.id)),
      groupsById: indexGroups(catalog()),
      selections: FULL_MEAL,
      maxDepth: 1,
    });
    const side = nodes[0].options[0].children[0];
    expect(side.options.find((o) => o.option.id === "o-fries")!.children).toEqual([]);
  });

  it("skips a nested id that resolves to no group", () => {
    // An option pointing at a group the API didn't return must render as a
    // plain option, not crash the picker.
    const all = catalog();
    all.find((g) => g.id === "g-meal")!.options = [
      opt("o-meal", "Make It a Meal", 3.99, ["g-ghost"]),
    ];
    const nodes = buildModifierTree({
      rootGroups: all.filter((g) => ROOTS.includes(g.id)),
      groupsById: indexGroups(all),
      selections: { [selectionKey([], "g-meal")]: ["o-meal"] },
    });
    expect(nodes[0].options[0].children).toEqual([]);
  });
});

describe("nested modifiers — selections and pricing", () => {
  it("flattens every level into one list, depth-first", () => {
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    expect(picked.map((m) => m.name)).toEqual([
      "Make It a Meal",
      "Fries",
      "Garlic Mayo",
      "Coke",
    ]);
  });

  it("rolls nested prices up into the line total", () => {
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    // 9.99 burger + 3.99 meal + 0 fries + 0.50 mayo + 0 coke
    expect(calculateCartItem({ basePrice: 9.99, modifiers: picked, quantity: 1 }))
      .toMatchObject({ unitPrice: 14.48, lineTotal: 14.48 });
  });

  it("multiplies a nested selection through quantity", () => {
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    expect(
      calculateCartItem({ basePrice: 9.99, modifiers: picked, quantity: 2 }).lineTotal,
    ).toBe(28.96);
  });

  it("drops the nested prices again when the parent is deselected", () => {
    const nodes = tree({ ...FULL_MEAL, [selectionKey([], "g-meal")]: [] });
    const picked = collectSelectedModifiers(nodes);
    expect(calculateCartItem({ basePrice: 9.99, modifiers: picked, quantity: 1 }).unitPrice)
      .toBe(9.99);
  });

  it("records the path so a ticket can read Meal → Fries → Garlic Mayo", () => {
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    expect(picked.find((m) => m.name === "Garlic Mayo")!.path).toEqual([
      "Make It a Meal",
      "Fries",
      "Garlic Mayo",
    ]);
  });

  it("records depth and parent option", () => {
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    expect(picked.find((m) => m.name === "Make It a Meal")).toMatchObject({
      depth: 0,
      parentOptionId: null,
    });
    expect(picked.find((m) => m.name === "Garlic Mayo")).toMatchObject({
      depth: 2,
      parentOptionId: "o-fries",
    });
  });

  it("still carries groupId on nested selections, for station routing", () => {
    // Kitchen routing buckets a line by the modifier groups it touches; a
    // nested selection with no groupId would never reach the fryer station.
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    expect(picked.find((m) => m.name === "Fries")!.groupId).toBe("g-side");
  });
});

describe("nested modifiers — required questions", () => {
  it("doesn't ask for a side until the meal is chosen", () => {
    expect(findUnmetRequirements(tree({}))).toEqual([]);
  });

  it("asks for both the side and the drink once the meal is chosen", () => {
    const unmet = findUnmetRequirements(
      tree({ [selectionKey([], "g-meal")]: ["o-meal"] }),
    );
    expect(unmet.map((u) => u.groupName)).toEqual(["Choose Side", "Choose Drink"]);
  });

  it("asks for the dip only once fries are chosen", () => {
    const unmet = findUnmetRequirements(
      tree({
        [selectionKey([], "g-meal")]: ["o-meal"],
        [selectionKey(["o-meal"], "g-side")]: ["o-fries"],
        [selectionKey(["o-meal"], "g-drink")]: ["o-coke"],
      }),
    );
    expect(unmet.map((u) => u.groupName)).toEqual(["Dip"]);
  });

  it("is satisfied when every open branch is answered", () => {
    expect(findUnmetRequirements(tree(FULL_MEAL))).toEqual([]);
  });

  it("doesn't ask for the dip when the side that opens it isn't chosen", () => {
    const unmet = findUnmetRequirements(
      tree({
        [selectionKey([], "g-meal")]: ["o-meal"],
        [selectionKey(["o-meal"], "g-side")]: ["o-waffle"],
        [selectionKey(["o-meal"], "g-drink")]: ["o-coke"],
      }),
    );
    expect(unmet).toEqual([]);
  });
});

describe("nested modifiers — toggling", () => {
  const key = selectionKey([], "g-meal");

  it("replaces the pick in a VARIANT group", () => {
    const next = toggleModifierSelection(
      { [key]: ["o-a"] },
      { key, optionId: "o-b", selectionType: "VARIANT" },
    );
    expect(next[key]).toEqual(["o-b"]);
  });

  it("lets an optional pick-one be un-picked", () => {
    // "Make It a Meal" is min 0 — the customer must be able to change their
    // mind and get the £3.99 back.
    const next = toggleModifierSelection(
      { [key]: ["o-meal"] },
      { key, optionId: "o-meal", selectionType: "VARIANT", minSelections: 0 },
    );
    expect(next[key]).toEqual([]);
  });

  it("keeps a required pick-one filled", () => {
    const next = toggleModifierSelection(
      { [key]: ["o-fries"] },
      { key, optionId: "o-fries", selectionType: "VARIANT", minSelections: 1 },
    );
    expect(next[key]).toEqual(["o-fries"]);
  });

  it("adds and removes in an ADDON group", () => {
    const added = toggleModifierSelection(
      {},
      { key, optionId: "o-a", selectionType: "ADDON", maxSelections: 2 },
    );
    expect(added[key]).toEqual(["o-a"]);
    const removed = toggleModifierSelection(added, {
      key,
      optionId: "o-a",
      selectionType: "ADDON",
      maxSelections: 2,
    });
    expect(removed[key]).toEqual([]);
  });

  it("refuses to exceed maxSelections", () => {
    const next = toggleModifierSelection(
      { [key]: ["o-a", "o-b"] },
      { key, optionId: "o-c", selectionType: "ADDON", maxSelections: 2 },
    );
    expect(next[key]).toEqual(["o-a", "o-b"]);
  });
});

describe("nested modifiers — what reaches the kitchen", () => {
  it("carries the nesting onto the order line", () => {
    // Every checkout path used to write {name, price} by hand and throw the
    // nesting away, so the ticket listed the meal, the side and the dip as
    // three unrelated extras.
    const picked = collectSelectedModifiers(tree(FULL_MEAL));
    const lines = picked.map(toOrderLineModifier);

    expect(lines.find((l) => l.name === "Garlic Mayo")).toEqual({
      name: "Garlic Mayo",
      price: 0.5,
      depth: 2,
      path: ["Make It a Meal", "Fries", "Garlic Mayo"],
      parentOptionId: "o-fries",
    });
  });

  it("leaves a flat selection exactly as it was", () => {
    // An order line for a flat menu must serialise identically to before,
    // or every existing consumer sees a changed shape for no reason.
    expect(toOrderLineModifier({ name: "Extra cheese", price: 1.5 })).toEqual({
      name: "Extra cheese",
      price: 1.5,
    });
  });

  it("indents a ticket line by its depth", () => {
    expect(modifierIndent({ depth: 0 })).toBe("");
    expect(modifierIndent({ depth: 1 })).toBe("  ");
    expect(modifierIndent({ depth: 2 })).toBe("    ");
  });

  it("indents an order placed before nesting existed at all", () => {
    expect(modifierIndent({})).toBe("");
    expect(modifierIndent({ depth: null })).toBe("");
  });

  it("refuses to indent a ticket off the edge of the paper", () => {
    // 42 columns. A corrupt depth must not push the name off the roll.
    expect(modifierIndent({ depth: 99 })).toBe("      ");
  });

  it("reads the path back on surfaces with room for it", () => {
    expect(
      formatModifierPath({ name: "Garlic Mayo", path: ["Make It a Meal", "Fries", "Garlic Mayo"] }),
    ).toBe("Make It a Meal → Fries → Garlic Mayo");
    expect(formatModifierPath({ name: "Extra cheese" })).toBe("Extra cheese");
  });
});

describe("nested modifiers — flat menus are untouched", () => {
  const flat: NestableGroup[] = [
    {
      id: "g-toppings",
      name: "Extra toppings",
      selectionType: "ADDON",
      minSelections: 0,
      maxSelections: 3,
      options: [opt("o-cheese", "Extra cheese", 1.5), opt("o-ham", "Ham", 1.0)],
    },
  ];

  it("reports no nesting", () => {
    expect(hasNestedGroups(flat)).toBe(false);
    expect(hasNestedGroups(catalog())).toBe(true);
  });

  it("prices a flat pick exactly as before", () => {
    const nodes = buildModifierTree({
      rootGroups: flat,
      groupsById: indexGroups(flat),
      selections: { [selectionKey([], "g-toppings")]: ["o-cheese"] },
    });
    const picked = collectSelectedModifiers(nodes);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      id: "o-cheese",
      groupId: "g-toppings",
      groupName: "Extra toppings",
      price: 1.5,
      depth: 0,
    });
    expect(calculateCartItem({ basePrice: 8, modifiers: picked, quantity: 1 }).unitPrice)
      .toBe(9.5);
  });

  it("hides an option the size context rules out", () => {
    // pricesBySize with no matching key means "not for this size" — the
    // existing rule, which must keep applying inside a nested group too.
    const sized: NestableGroup[] = [
      {
        id: "g-x",
        name: "Toppings",
        selectionType: "ADDON",
        minSelections: 0,
        options: [
          { id: "o-1", name: "Ten only", priceAdjustment: 0, pricesBySize: { "10": 1 } },
          { id: "o-2", name: "Any size", priceAdjustment: 1 },
        ],
      },
    ];
    const nodes = buildModifierTree({
      rootGroups: sized,
      groupsById: indexGroups(sized),
      selections: {},
      sizeKey: "12",
    });
    expect(nodes[0].options.map((o) => o.option.id)).toEqual(["o-2"]);
  });
});

// ── Stepped picker ──────────────────────────────────────────────────────────
//
// The till and the kiosk ask one group per screen instead of presenting a
// scroller. The step list is derived from the SAME tree the scrolling view
// renders, so the two can never disagree about what is being asked.
//
// The hard part is that the list is not fixed: a nested group only becomes a
// question once its parent is chosen, so steps appear and vanish underneath
// the operator while they work.

describe("stepped picker — the step list", () => {
  it("asks only the top-level group until the meal is ticked", () => {
    expect(flattenModifierSteps(tree({})).map((n) => n.group.id)).toEqual([
      "g-meal",
    ]);
  });

  it("inserts the nested groups directly after the option that opens them", () => {
    // Side and drink must be asked NEXT, not appended after unrelated groups
    // — the operator is standing in front of the customer who just said yes
    // to a meal.
    const steps = flattenModifierSteps(
      tree({ [selectionKey([], "g-meal")]: ["o-meal"] }),
    );
    expect(steps.map((n) => n.group.id)).toEqual([
      "g-meal",
      "g-side",
      "g-drink",
    ]);
  });

  it("goes a level deeper as the side is chosen", () => {
    // Fries opens a dip, so the dip becomes step 3 of 4 mid-flow.
    const steps = flattenModifierSteps(tree(FULL_MEAL));
    expect(steps.map((n) => n.group.id)).toEqual([
      "g-meal",
      "g-side",
      "g-dip",
      "g-drink",
    ]);
  });

  it("removes the steps again when the meal is unticked", () => {
    // The operator goes Back and changes their mind. Three questions vanish,
    // and a step index held across that change would point past the end —
    // which is why callers clamp instead of remembering.
    const steps = flattenModifierSteps(
      tree({ ...FULL_MEAL, [selectionKey([], "g-meal")]: [] }),
    );
    expect(steps.map((n) => n.group.id)).toEqual(["g-meal"]);
  });

  it("keeps the same branch keys the scrolling view uses", () => {
    // Both views drive one selections object. If the step list invented its
    // own keys, a choice made in one would be invisible to the other.
    const steps = flattenModifierSteps(tree(FULL_MEAL));
    expect(steps.map((n) => n.key)).toEqual([
      selectionKey([], "g-meal"),
      selectionKey(["o-meal"], "g-side"),
      selectionKey(["o-meal", "o-fries"], "g-dip"),
      selectionKey(["o-meal"], "g-drink"),
    ]);
  });
});

describe("stepped picker — when Next is allowed", () => {
  it("blocks a required group with nothing chosen", () => {
    const steps = flattenModifierSteps(
      tree({ [selectionKey([], "g-meal")]: ["o-meal"] }),
    );
    const side = steps.find((n) => n.group.id === "g-side")!;
    expect(isStepSatisfied(side)).toBe(false);
  });

  it("allows it once the minimum is met", () => {
    const steps = flattenModifierSteps(tree(FULL_MEAL));
    const side = steps.find((n) => n.group.id === "g-side")!;
    expect(isStepSatisfied(side)).toBe(true);
  });

  it("lets an optional group through untouched", () => {
    // "Make It a Meal" is min 0 — declining it must not trap the operator.
    const meal = flattenModifierSteps(tree({}))[0]!;
    expect(isStepSatisfied(meal)).toBe(true);
  });

  it("agrees with findUnmetRequirements, which gates the Add button", () => {
    // Two different checks over one tree. If they ever disagree, Next is
    // enabled on a step that still blocks the order.
    const steps = flattenModifierSteps(
      tree({ [selectionKey([], "g-meal")]: ["o-meal"] }),
    );
    const blocked = steps.filter((n) => !isStepSatisfied(n)).map((n) => n.group.id);
    const unmet = findUnmetRequirements(
      tree({ [selectionKey([], "g-meal")]: ["o-meal"] }),
    ).map((u) => u.groupId);
    expect(blocked.sort()).toEqual(unmet.sort());
  });
});

describe("stepped picker — auto-advance", () => {
  it("advances on a pick-exactly-one group", () => {
    const side = flattenModifierSteps(tree(FULL_MEAL)).find(
      (n) => n.group.id === "g-side",
    )!;
    expect(shouldAutoAdvance(side)).toBe(true);
  });

  it("waits on an optional group — declining is a real answer", () => {
    // "Make It a Meal" is min 0 / max 1. Auto-advancing on the tick would be
    // fine, but the operator also has to be able to move on WITHOUT ticking,
    // so this step keeps its Next button.
    const meal = flattenModifierSteps(tree({}))[0]!;
    expect(shouldAutoAdvance(meal)).toBe(false);
  });

  it("waits on a multi-select — only the operator knows when they're done", () => {
    const all = catalog();
    const side = all.find((g) => g.id === "g-side")!;
    side.selectionType = "ADDON";
    side.minSelections = 0;
    side.maxSelections = 3;
    const nodes = buildModifierTree({
      rootGroups: all.filter((g) => g.id === "g-side"),
      groupsById: indexGroups(all),
      selections: {},
    });
    expect(shouldAutoAdvance(nodes[0]!)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// "Allow duplicate selections" — extra cheese × 2
//
// The flag has always existed on the group and has always been published to
// Deliveroo and Just Eat as `repeatable`. The till and the storefront simply
// never honoured it: a second tap removed the first pick, so a group set to
// allow two of the same could only ever hold one.
// ──────────────────────────────────────────────────────────────────────────

describe("duplicate selections", () => {
  const sauces = (): NestableGroup[] => [
    {
      id: "g-sauce",
      name: "Kebab - Sauce",
      selectionType: "ADDON",
      minSelections: 1,
      maxSelections: 2,
      allowDuplicateSelections: true,
      options: [opt("o-garlic", "Garlic Sauce", 0.5), opt("o-chilli", "Chilli Sauce")],
    },
  ];

  const build = (selections: Record<string, string[]>) =>
    buildModifierTree({
      rootGroups: sauces(),
      groupsById: indexGroups(sauces()),
      selections,
    });

  const tap = (selections: Record<string, string[]>, optionId: string) =>
    toggleModifierSelection(selections, {
      key: "g-sauce",
      optionId,
      selectionType: "ADDON",
      minSelections: 1,
      maxSelections: 2,
      allowDuplicates: true,
    });

  it("takes the same option twice", () => {
    const once = tap({}, "o-garlic");
    const twice = tap(once, "o-garlic");
    expect(twice["g-sauce"]).toEqual(["o-garlic", "o-garlic"]);
  });

  it("still stops at the group's maximum, counting copies", () => {
    const twice = tap(tap({}, "o-garlic"), "o-garlic");
    expect(tap(twice, "o-chilli")).toEqual(twice);
  });

  it("charges for every copy", () => {
    const picked = collectSelectedModifiers(
      build({ "g-sauce": ["o-garlic", "o-garlic"] }),
    );
    expect(picked).toHaveLength(2);
    expect(picked.reduce((n, m) => n + m.price, 0)).toBeCloseTo(1.0);
  });

  it("reports the quantity on the tree so the picker can show a stepper", () => {
    const node = build({ "g-sauce": ["o-garlic", "o-garlic"] })[0]!;
    const garlic = node.options.find((o) => o.option.id === "o-garlic")!;
    expect(garlic.quantity).toBe(2);
    expect(garlic.selected).toBe(true);
    expect(node.options.find((o) => o.option.id === "o-chilli")!.quantity).toBe(0);
  });

  it("counts copies toward a required minimum", () => {
    // "Choose 2 sauces" is answered by two of the same one.
    const nodes = build({ "g-sauce": ["o-garlic", "o-garlic"] });
    sauces()[0]!.minSelections = 2;
    expect(findUnmetRequirements(nodes)).toEqual([]);
  });

  it("removes one copy at a time, newest first", () => {
    const state = { "g-sauce": ["o-garlic", "o-chilli", "o-garlic"] };
    const next = adjustModifierQuantity(state, {
      key: "g-sauce",
      optionId: "o-garlic",
      delta: -1,
      maxSelections: 2,
    });
    expect(next["g-sauce"]).toEqual(["o-garlic", "o-chilli"]);
  });

  it("leaves an ordinary group alone — a second tap still unticks", () => {
    const state = toggleModifierSelection({}, {
      key: "g-plain",
      optionId: "o-garlic",
      selectionType: "ADDON",
      maxSelections: 2,
    });
    const off = toggleModifierSelection(state, {
      key: "g-plain",
      optionId: "o-garlic",
      selectionType: "ADDON",
      maxSelections: 2,
    });
    expect(off["g-plain"]).toEqual([]);
  });
});
