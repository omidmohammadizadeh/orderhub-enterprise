// Choices on Pizza Uno Pelton's real menu, found by running every item, group
// and option on it through add_item.
//
// Each group below is copied from the live menu, spelling and stray spaces
// included — "CAN CKOE", '10"KEBAB PIZZA ', burgers sized "1/4" — because the
// faults lived in exactly those details: a size written as a fraction nobody
// says, a drink whose first word sounds like a number, two pizza lists that
// differ only by their inches, and dish names that answered their own
// questions.

import { VoiceAiService } from "../voice-ai.service";
import { saysOptionBeyond, sizeClash, splitQuantity, splitQuantityAgainst } from "../voice-menu-match";

const opt = (id: string, name: string, price = 0) => ({ id, name, price });
const group = (id: string, name: string, options: any[], rules: Record<string, unknown> = {}) => ({
  id,
  name,
  required: false,
  min: 1,
  max: 1,
  selectionType: "VARIANT",
  repeats: false,
  options,
  ...rules,
});
const sauces = (p: string) =>
  group(`${p}-sauce`, "SELECT YOUR SAUCE", [opt(`${p}-chilli`, "+CHILLI"), opt(`${p}-nosauce`, "NO SAUCE "), opt(`${p}-garlic`, "+GARLIC")]);
const chipsOrSalad = (p: string) => group(`${p}-cos`, "CHIPS OR SALAD", [opt(`${p}-chips`, "+CHIPS"), opt(`${p}-salad`, "+SALAD")]);
const twelves = (p: string) =>
  group(`${p}`, 'SELECT YOUR 12" PIZZA', [
    opt(`${p}-pep`, '12" PEPPERONI'),
    opt(`${p}-ham`, '12" HAM'),
    opt(`${p}-keb`, '12" KEBAB PIZZA '),
    opt(`${p}-paz`, '12" PAZZA'),
    opt(`${p}-4mt`, '12" FOUR MEAT'),
    opt(`${p}-mb`, '12" MEAT BALLS'),
    opt(`${p}-ms`, '12" MEAT SUPREME'),
    opt(`${p}-tsc`, '12" TUNA&SWEET CORN'),
    opt(`${p}-csc`, '12" CHICKEN&SWEET CORN'),
  ]);

const ITEMS = [
  {
    id: "chilli-burger",
    name: "CHILLI BURGER",
    price: 4.7,
    categoryName: "🍔 BURGERS 🍔",
    modifierGroups: [
      group("cb-size", "SELECT YOUR BURGER SIZE", [opt("cb-q", "1/4"), opt("cb-h", "1/2", 1)]),
      sauces("cb"),
      group("cb-sp", "SALAD OR PLAIN", [opt("cb-salad", "+SALAD"), opt("cb-plain", "+PLAIN")]),
    ],
  },
  {
    id: "nuggets",
    name: "CHICKEN NUGET&CHIPS(10PCS)",
    price: 6.1,
    categoryName: "CHICKEN",
    modifierGroups: [chipsOrSalad("ng")],
  },
  {
    id: "gb-special",
    name: "GARLIC BREAD SPECIAL",
    price: 10.5,
    categoryName: "GARLIC BREADS",
    modifierGroups: [
      group("gb-size", "CHOOSE SIZE", [opt("gb-10", '10"'), opt("gb-12", '12"', 1.5)]),
      chipsOrSalad("gb"),
      sauces("gb"),
    ],
  },
  {
    id: "deal4",
    name: "MEAL DEAL 4",
    price: 26.3,
    categoryName: "MEAL DEALS",
    modifierGroups: [
      group("d4-chips", "SELECT YOUR CHIPS", [opt("d4-chips-1", "+CHIPS")]),
      group(
        "d4-drink",
        "SELECT YOUR DRINK",
        [
          opt("d4-coke", "CAN CKOE"),
          opt("d4-sprite", "CAN SPRITE"),
          opt("d4-drp", "CAN DR PEPPER"),
          opt("d4-fanta", "CAN FANTA"),
          opt("d4-diet", "CAN DIET COKE "),
        ],
        { selectionType: "ADDON", min: 2, max: 2 },
      ),
      twelves("d4-p1"),
      twelves("d4-p2"),
    ],
  },
  {
    id: "mega",
    name: "MEGA BOX",
    price: 28.5,
    categoryName: "MEAL DEALS",
    modifierGroups: [
      group("mb-10", 'SELECT YOUR 10" PIZZA', [
        opt("mb-10-paz", '10" PAZZA'),
        opt("mb-10-keb", '10"KEBAB PIZZA '),
        opt("mb-10-4mt", '10" FOUR MEAT'),
        opt("mb-10-pep", '10" PEPPERONI'),
      ]),
      twelves("mb-12"),
    ],
  },
];

function ctx(): any {
  const itemIndex = new Map(ITEMS.map((i) => [i.id, i]));
  const optionIndex = new Map();
  for (const i of ITEMS)
    for (const g of i.modifierGroups) for (const o of g.options) optionIndex.set(o.id, { groupId: g.id, itemId: i.id, option: o });
  return { currency: "GBP", country: "GB", locationName: "Pizza Uno Pelton", items: ITEMS, itemIndex, optionIndex, deliveryZones: [] };
}

function add(itemId: string, said: string, modifierNames?: string[]) {
  const ai: any = Object.create(VoiceAiService.prototype);
  ai.logger = { log() {}, warn() {}, error() {} };
  const c = ctx();
  const state: any = { cart: { items: [], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] };
  const out = String(ai.addItemConversational({ said, itemId, ...(modifierNames ? { modifierNames } : {}) }, c, state).result);
  const ids: string[] = state.draft ? state.draft.picks.map((p: any) => p.o) : (state.cart.items.at(-1)?.modifiers ?? []).map((m: any) => m.optionId);
  return { out, ids, added: /^Added/.test(out) };
}

describe("burger sizes written as fractions", () => {
  it("understands a quarter and a half however they are said", () => {
    expect(add("chilli-burger", "chilli burger", ["quarter"]).ids).toContain("cb-q");
    expect(add("chilli-burger", "chilli burger", ["quarter pounder"]).ids).toContain("cb-q");
    expect(add("chilli-burger", "chilli burger", ["1/4"]).ids).toContain("cb-q");
    expect(add("chilli-burger", "chilli burger", ["half pound"]).ids).toContain("cb-h");
    expect(add("chilli-burger", "chilli burger", ["half"]).ids).toContain("cb-h");
  });

  it("reads the sizes out as words, not as one-slash-four", () => {
    expect(add("chilli-burger", "chilli burger").out).toContain("burger size (quarter, half)");
  });

  it("completes the burger in one breath", () => {
    const r = add("chilli-burger", "chilli burger", ["quarter pounder", "garlic", "salad"]);
    expect(r.added).toBe(true);
    expect(r.ids.sort()).toEqual(["cb-garlic", "cb-q", "cb-salad"]);
  });
});

describe("a dish's own name does not answer its choices", () => {
  it("asks the chilli burger's sauce rather than assuming chilli", () => {
    const r = add("chilli-burger", "chilli burger");
    expect(r.ids).not.toContain("cb-chilli");
    expect(r.out).toContain("sauce (");
  });

  it("takes the sauce they did say, and chilli when they say it again", () => {
    expect(add("chilli-burger", "chilli burger with garlic sauce").ids).toEqual(["cb-garlic"]);
    expect(add("chilli-burger", "chilli burger with chilli sauce").ids).toEqual(["cb-chilli"]);
  });

  it("does not give the garlic bread special garlic sauce", () => {
    expect(add("gb-special", "garlic bread special").ids).toEqual([]);
  });

  it("takes a size said in words, with its unit", () => {
    expect(add("gb-special", "twelve inch garlic bread special").ids).toEqual(["gb-12"]);
    expect(add("gb-special", "garlic bread special, ten inch, with chips").ids.sort()).toEqual(["gb-10", "gb-chips"]);
  });

  it("asks nuggets & chips for chips or salad, and takes salad when said", () => {
    const plain = add("nuggets", "chicken nuggets and chips");
    expect(plain.added).toBe(false);
    expect(plain.out).toContain("chips or salad");
    const salad = add("nuggets", "chicken nuggets and chips with salad");
    expect(salad.added).toBe(true);
    expect(salad.ids).toEqual(["ng-salad"]);
  });

  it("still reads a choice whose words go beyond the dish name", () => {
    expect(saysOptionBeyond("donner kebab box", "DONNER KEBAB", "KEBAB BOX SPECIAL")).toBe(true);
    expect(saysOptionBeyond("chilli burger", "+CHILLI", "CHILLI BURGER")).toBe(false);
  });
});

describe("two pizza lists that differ only by size", () => {
  it("puts a 12 inch pizza in the 12 inch list", () => {
    const r = add("mega", "mega box", ["12 inch kebab pizza"]);
    expect(r.ids).toContain("mb-12-keb");
    expect(r.ids).not.toContain("mb-10-paz");
  });

  it("places both sizes when said together, quote marks or words", () => {
    const r = add("mega", "mega box", ['12" pazza', "10 inch four meat"]);
    expect(r.added).toBe(true);
    expect(r.ids.sort()).toEqual(["mb-10-4mt", "mb-12-paz"]);
  });

  it("only calls it a clash when both sides name a size", () => {
    expect(sizeClash("12 inch kebab pizza", '10"KEBAB PIZZA  SELECT YOUR 10" PIZZA')).toBe(true);
    expect(sizeClash("twelve inch pazza", '12" PAZZA SELECT YOUR 12" PIZZA')).toBe(false);
    expect(sizeClash("pazza", '10" PAZZA')).toBe(false);
    expect(sizeClash("four meat", '10" FOUR MEAT')).toBe(false);
  });
});

describe("a drink that starts like a number", () => {
  it("is a Dr Pepper, not three pepperoni", () => {
    expect(splitQuantity("dr pepper")).toEqual({ quantity: 1, rest: "dr pepper" });
    expect(splitQuantity("Drie coli")).toEqual({ quantity: 3, rest: "coli" });
    const r = add("deal4", "meal deal 4", ["dr pepper", "fanta"]);
    expect(r.ids).toEqual(expect.arrayContaining(["d4-drp", "d4-fanta"]));
    expect(r.ids.some((id) => id.includes("-pep"))).toBe(false);
  });

  it("does not read a pizza's first word as a count", () => {
    expect(splitQuantityAgainst("four meat", ['12" FOUR MEAT'])).toEqual({ quantity: 1, rest: "four meat" });
    expect(splitQuantityAgainst("two pepperoni", ['12" PEPPERONI'])).toEqual({ quantity: 2, rest: "pepperoni" });
    const r = add("deal4", "meal deal 4", ["tuna and sweet corn", "four meat"]);
    expect(r.ids).toEqual(expect.arrayContaining(["d4-p1-tsc", "d4-p2-4mt"]));
  });

  it("finds a kebab pizza whose size is glued to its name", () => {
    const r = add("mega", "mega box", ["kebab pizza"]);
    expect(r.ids).toContain("mb-10-keb");
    expect(r.ids).not.toContain("mb-10-paz");
  });

  it("fills MEAL DEAL 4's two pizza slots and two drinks", () => {
    const r = add("deal4", "meal deal 4", ["coke", "diet coke", "pepperoni", "kebab pizza"]);
    expect(r.added).toBe(true);
    expect(r.ids.sort()).toEqual(["d4-chips-1", "d4-coke", "d4-diet", "d4-p1-pep", "d4-p2-keb"].sort());
  });
});
