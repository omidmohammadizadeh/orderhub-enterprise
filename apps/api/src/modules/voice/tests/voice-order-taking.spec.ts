// Ordering food, which is the part of the call the caller came for.
//
// A probe against the live matcher found the ordering step was structurally
// unable to succeed on a menu with sizes:
//
//   a large margherita   confident=false   (10"):0.50  (12"):0.50  (14"):0.50
//   a coke               confident=false   Coca-Cola 330ml:0.67
//   chips                confident=false   (nothing at all)
//
// The size suffix put every sized dish under the confidence bar and tied it
// with its own siblings, so the clear-leader test could never pass either.
// These lock in the shape that replaced it.

import {
  groupBySize,
  isConfidentGroup,
  matchItemGroups,
  pickVariant,
  sizesAloud,
  splitSize,
  stripSizeWords,
} from "../voice-menu-match";

const MENU = [
  { id: "m10", name: 'Margherita (10")' },
  { id: "m12", name: 'Margherita (12")' },
  { id: "m14", name: 'Margherita (14")' },
  { id: "pep", name: "Pepperoni Pizza" },
  { id: "gb", name: "Garlic Bread" },
  { id: "coke", name: "Coca-Cola 330ml" },
  { id: "fries", name: "French Fries" },
  { id: "cb", name: "Chicken Burger" },
  { id: "cw", name: "Chicken Wrap" },
];

const best = (said: string) => {
  const m = matchItemGroups(said, MENU, { limit: 3 });
  return { matches: m, confident: isConfidentGroup(m), top: m[0]?.group };
};

describe("splitSize", () => {
  it("separates the dish from its size", () => {
    expect(splitSize('Margherita (10")')).toEqual({ base: "Margherita", size: '10"' });
    expect(splitSize("Chicken Burger")).toEqual({ base: "Chicken Burger", size: null });
  });

  it("leaves a name that is only a parenthesis alone", () => {
    expect(splitSize("(12\")").base).toBe('(12")');
  });
});

describe("groupBySize", () => {
  it("puts a flattened menu back together as dishes", () => {
    const groups = groupBySize(MENU);
    const margherita = groups.find((g) => g.base === "Margherita");
    expect(margherita?.variants.map((v) => v.id)).toEqual(["m10", "m12", "m14"]);
    expect(groups.find((g) => g.base === "Garlic Bread")?.variants).toHaveLength(1);
  });
});

describe("stripSizeWords", () => {
  it("removes the size so being specific is not a penalty", () => {
    expect(stripSizeWords("a large margherita")).toBe("a margherita");
    expect(stripSizeWords("twelve inch pepperoni")).toBe("pepperoni");
    expect(stripSizeWords("10 inch margherita")).toBe("margherita");
  });
});

describe("matching a dish", () => {
  it("is certain about a plainly-said sized dish — the old bar it could not clear", () => {
    const { confident, top } = best("a large margherita");
    expect(confident).toBe(true);
    expect(top?.base).toBe("Margherita");
  });

  it("is certain about the bare dish name too", () => {
    expect(best("margherita").confident).toBe(true);
  });

  it("knows what a caller calls things, not just what the menu calls them", () => {
    // "chips" scored zero against "French Fries" and returned nothing at all.
    const chips = best("chips");
    expect(chips.confident).toBe(true);
    expect(chips.top?.base).toBe("French Fries");

    const coke = best("a coke");
    expect(coke.confident).toBe(true);
    expect(coke.top?.base).toBe("Coca-Cola 330ml");
  });

  it("still refuses to choose between two genuinely different dishes", () => {
    // A wrong guess here is a wrong meal cooked.
    const { confident, matches } = best("chicken");
    expect(confident).toBe(false);
    expect(matches.map((m) => m.group.base).sort()).toEqual([
      "Chicken Burger",
      "Chicken Wrap",
    ]);
  });

  it("survives the transcript mangling a dish", () => {
    // Real shape of a phone mis-hearing: voiced/voiceless swaps.
    expect(best("karlic bret").top?.base).toBe("Garlic Bread");
  });
});

describe("picking the size", () => {
  const margherita = groupBySize(MENU).find((g) => g.base === "Margherita")!.variants;

  it("takes a number the caller actually said", () => {
    expect(pickVariant("twelve inch margherita", margherita)?.id).toBe("m12");
    expect(pickVariant("10 inch margherita", margherita)?.id).toBe("m10");
  });

  it("reads small and large as the ends of the shop's own list", () => {
    expect(pickVariant("a large margherita", margherita)?.id).toBe("m14");
    expect(pickVariant("small margherita", margherita)?.id).toBe("m10");
    expect(pickVariant("medium margherita", margherita)?.id).toBe("m12");
  });

  it("orders by the number, not by however the menu happens to be sorted", () => {
    const jumbled = [
      { id: "b", name: 'Margherita (14")' },
      { id: "a", name: 'Margherita (10")' },
      { id: "c", name: 'Margherita (12")' },
    ];
    expect(pickVariant("large margherita", jumbled)?.id).toBe("b");
    expect(pickVariant("small margherita", jumbled)?.id).toBe("a");
  });

  it("matches a size named in words", () => {
    const drinks = [
      { id: "s", name: "Pepsi (Regular)" },
      { id: "l", name: "Pepsi (Large)" },
    ];
    expect(pickVariant("large pepsi", drinks)?.id).toBe("l");
    expect(pickVariant("regular pepsi", drinks)?.id).toBe("s");
  });

  it("says nothing rather than guessing when no size was mentioned", () => {
    expect(pickVariant("margherita please", margherita)).toBeNull();
  });

  it("does not need asking when there is only one size", () => {
    expect(pickVariant("garlic bread", [{ id: "gb", name: "Garlic Bread" }])?.id).toBe("gb");
  });
});

describe("asking about size out loud", () => {
  it("asks the way a person would, not the way the menu is stored", () => {
    const margherita = groupBySize(MENU).find((g) => g.base === "Margherita")!.variants;
    expect(sizesAloud(margherita)).toBe("10 inch, 12 inch or 14 inch");
  });
});
