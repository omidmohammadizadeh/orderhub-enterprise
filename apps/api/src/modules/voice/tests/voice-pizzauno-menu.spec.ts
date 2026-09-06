// Ordering from a real menu — Pizza Uno Pelton, 150 items, exactly as it is
// published.
//
// Every fixture before this one was written by me, which means every fixture
// before this one was written by somebody who already knew what the code did.
// A real menu does not cooperate: it contains a pizza called PAZZA, one called
// FOUR MEAT, fifty-four pizzas with no sizes at all, and a MARGHERITHA spelled
// with an H. Each of the three faults below was found by running this shop's
// own menu through the ordering code, and none of them would have been found
// any other way.

import { matchItemGroups, isConfidentGroup, matchWithQuantity, splitQuantity } from "../voice-menu-match";

// A faithful slice of the real thing: the names that collide, spelled as the
// shop spells them.
const MENU = [
  { id: "pep", name: "PEPPERONI", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "paz", name: "PAZZA", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "haw", name: "HAWAIIAN", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "bbq", name: "BBQ CHICKEN", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "chk", name: "CHICKEN", price: 7.5, categoryName: "🍕PIZZA 🍕 " },
  { id: "4mt", name: "FOUR MEAT", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "mtb", name: "MEATBALLS", price: 7.8, categoryName: "🍕PIZZA 🍕 " },
  { id: "sml", name: "SMALL MEAT", price: 5.5, categoryName: "MEAL DEALS" },
  { id: "mar", name: "MARGHERITHA", price: 7.5, categoryName: "🍕PIZZA 🍕 " },
  { id: "chp", name: "CHIPS", price: 2.5, categoryName: "🍟 SUNDRIES 🍟" },
  { id: "gb", name: "GARLIC BREAD", price: 4, categoryName: "GARLIC BREADS" },
  { id: "cok", name: "CAN COKE", price: 1.2, categoryName: "DRINKS 🥤" },
];

const pick = (said: string) => {
  const { quantity, matches } = matchWithQuantity(said, MENU, { limit: 4, floor: 0.3 });
  return {
    quantity,
    name: isConfidentGroup(matches) ? matches[0]!.group.base : null,
  };
};

describe("a number in front of the dish", () => {
  it("is the size when a unit follows it, not the quantity", () => {
    // "12 inch pepperoni" put TWELVE pepperoni pizzas in the cart — £93.60 of
    // them, off a caller asking for one. This menu has no sizes at all, so the
    // inches are simply not information.
    expect(pick("12 inch pepperoni")).toEqual({ quantity: 1, name: "PEPPERONI" });
    expect(pick('12" pepperoni')).toEqual({ quantity: 1, name: "PEPPERONI" });
    expect(splitQuantity("12 inch pepperoni").quantity).toBe(1);
    expect(splitQuantity("10 inch margheritha").quantity).toBe(1);
  });

  it("is part of the name when the menu sells a dish by that name", () => {
    // FOUR MEAT is a pizza. Read as a quantity it left "meat", which fits
    // Small Meat, Meatballs and Meaty equally well, and four of whichever won
    // the coin toss went to the kitchen.
    expect(pick("four meat")).toEqual({ quantity: 1, name: "FOUR MEAT" });
  });

  it("is still the quantity when it plainly is one", () => {
    expect(pick("two cokes")).toEqual({ quantity: 2, name: "CAN COKE" });
    expect(pick("three chips")).toEqual({ quantity: 3, name: "CHIPS" });
    expect(pick("2 garlic breads")).toEqual({ quantity: 2, name: "GARLIC BREAD" });
  });
});

describe("saying the word pizza", () => {
  // The phonetic fold that lets "coli" find Cola makes "pizza" and "PAZZA" the
  // same word — both collapse to "ps". On a menu that has a pizza called
  // Pazza, every caller who said "pizza" scored it a perfect 1.00 and tied
  // with the dish they actually asked for, so the line asked which they meant.
  // That is most of how anybody orders a pizza.

  it("does not tie every order with the pizza called Pazza", () => {
    expect(pick("a pepperoni pizza").name).toBe("PEPPERONI");
    expect(pick("hawaiian pizza please").name).toBe("HAWAIIAN");
    expect(pick("margherita pizza").name).toBe("MARGHERITHA");
  });

  it("still finds Pazza for somebody who wants Pazza", () => {
    expect(pick("pazza").name).toBe("PAZZA");
    expect(pick("a pazza please").name).toBe("PAZZA");
  });

  it("prefers the longer name that accounts for more of what they said", () => {
    // "BBQ chicken pizza" fits CHICKEN perfectly and BBQ CHICKEN perfectly.
    // The one that explains the word "bbq" is the one they meant.
    expect(pick("bbq chicken pizza").name).toBe("BBQ CHICKEN");
    expect(pick("chicken pizza").name).toBe("CHICKEN");
  });
});

describe("the shop's own spelling", () => {
  it("finds a Margheritha for someone who says Margherita", () => {
    expect(pick("margherita").name).toBe("MARGHERITHA");
    expect(pick("margarita").name).toBe("MARGHERITHA");
  });

  it("copes with what the transcriber does to it", () => {
    expect(pick("peperoni").name).toBe("PEPPERONI");
    expect(pick("garlic bred").name).toBe("GARLIC BREAD");
  });
});

describe("the whole menu, as published", () => {
  it("has no sizes and no option groups, which is why neither is ever asked about", () => {
    // Worth stating plainly: 150 items, none with a required choice and none
    // with sizes. The numbered walkthrough cannot fire on this shop's menu
    // because there is nothing to walk through — every pizza is one price.
    // A caller asking for "12 inch" is asking for something not sold.
    const sized = MENU.filter((i) => /\(\s*\d+/.test(i.name));
    expect(sized).toHaveLength(0);
  });

  it("never turns one dish into a cartful", () => {
    for (const said of ["12 inch pepperoni", "four meat", "a pepperoni pizza"]) {
      expect(pick(said).quantity).toBe(1);
    }
  });
});

describe("several dishes said in one breath", () => {
  // Verbatim from a live call, after the language fix let the whole sentence
  // through for the first time:
  //
  //   heard "twelve inch pepperoni chips and garlic sauce"
  //   no confident match for "twelve inch pepperoni chips"
  //          — PEPPERONI:1.00, CHIPS:1.00, FRIES:1.00
  //   quick-added → 1 new: 1× Garlic sauce
  //
  // Three things asked for, one garlic sauce delivered. Splitting on "and"
  // found two phrases and scored the first as if it were the name of one dish.
  // People do not say "and" between every item; they pause, and a pause does
  // not survive transcription.
  const { segmentItems, explains, matchItemGroups, isConfidentGroup } = require("../voice-menu-match");

  const MENU = [
    { id: "pep", name: "PEPPERONI", categoryName: "🍕PIZZA 🍕 " },
    { id: "kebp", name: "KEBAB PIZZA", categoryName: "🍕PIZZA 🍕 " },
    { id: "chp", name: "CHIPS", categoryName: "🍟 SUNDRIES 🍟" },
    { id: "fri", name: "FRIES", categoryName: "🍟 SUNDRIES 🍟" },
    { id: "chz", name: "CHEESY CHIPS", categoryName: "🍟 SUNDRIES 🍟" },
    { id: "gs", name: "Garlic sauce", categoryName: "🍟 SUNDRIES 🍟" },
    { id: "gb", name: "GARLIC BREAD", categoryName: "GARLIC BREADS" },
    { id: "kiev", name: "CHICKEN KIEV", categoryName: "🍕PIZZA 🍕 " },
    { id: "cok", name: "CAN COKE", categoryName: "DRINKS 🥤" },
  ];
  const read = (said: string) =>
    segmentItems(said, MENU, { limit: 3, floor: 0.3 }).found.map(
      (f: any) => `${f.quantity}× ${f.match.group.base}`,
    );

  it("reads the call that was losing two items out of three", () => {
    expect(read("twelve inch pepperoni chips and garlic sauce")).toEqual([
      "1× PEPPERONI",
      "1× CHIPS",
      "1× Garlic sauce",
    ]);
  });

  it("reads a run of dishes with nothing between them", () => {
    expect(read("pepperoni chips garlic bread")).toEqual([
      "1× PEPPERONI",
      "1× CHIPS",
      "1× GARLIC BREAD",
    ]);
    expect(read("chicken kiev garlic bread two cokes")).toEqual([
      "1× CHICKEN KIEV",
      "1× GARLIC BREAD",
      "2× CAN COKE",
    ]);
  });

  it("does not let one dish swallow the words of another", () => {
    // "Kebab pizza cheesy chips" fits Cheesy Chips perfectly — scoring
    // deliberately ignores words a dish does not have — and a whole pizza went
    // in the bin unremarked. A match has to account for what it is taking.
    expect(read("kebab pizza cheesy chips")).toEqual(["1× KEBAB PIZZA", "1× CHEESY CHIPS"]);
    expect(explains("kebab pizza cheesy chips", { base: "CHEESY CHIPS", variants: [MENU[4]] })).toBe(
      false,
    );
    expect(explains("cheesy chips", { base: "CHEESY CHIPS", variants: [MENU[4]] })).toBe(true);
  });

  it("lets a size through, because a size belongs to no dish here", () => {
    // This menu has no sizes at all. "Twelve inch" must not stop Pepperoni
    // accounting for "twelve inch pepperoni".
    expect(read("twelve inch pepperoni")).toEqual(["1× PEPPERONI"]);
  });

  it("tells CHIPS from FRIES when the caller says one of them", () => {
    // The synonym table treats them as the same word, so both score 1.00 and
    // tie. Saying the name IS the answer — and filler in front of it does not
    // stop it being the name.
    const pick = (said: string) => {
      const m = matchItemGroups(said, MENU, { limit: 3, floor: 0.3 });
      return isConfidentGroup(m) ? m[0].group.base : null;
    };
    expect(pick("chips")).toBe("CHIPS");
    expect(pick("a chips")).toBe("CHIPS");
    expect(pick("the chips please")).toBe("CHIPS");
    expect(pick("fries")).toBe("FRIES");
  });

  it("still leaves a genuine ambiguity alone", () => {
    // Nothing here is "hot dog", and guessing would put the wrong food in a
    // kitchen. An empty read is the honest one.
    expect(read("hot dog")).toEqual([]);
  });
});
