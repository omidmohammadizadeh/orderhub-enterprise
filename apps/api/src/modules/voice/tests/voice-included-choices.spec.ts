import { includedGroup, matchOptionResult, uniqueByName } from "../voice-menu-match";

// Call aHD58t7Q: a MEGA BOX — two pizzas of your choice, all three quarter
// burgers, two garlic dips. The caller chose the pizzas and was then asked
// which burger (the box comes with all three), then which garlic dip, then
// which garlic dip again, five times, while the model invented a "garlic and
// herb" and a "BBQ" that do not exist. Two faults: the till lists "+garlic
// dip" twice so it can tick two, and the matcher read the twins as a dead
// heat; and a group the dish simply comes with was treated as a question.

const opt = (id: string, name: string, price = 0) => ({ id, name, price });
const G = (id: string, name: string, opts: any[], over: any = {}) => ({
  id,
  name,
  required: true,
  min: 1,
  max: 1,
  selectionType: "VARIANT",
  options: opts,
  ...over,
});

const TEN = ["10\" AMELIO", "10\" POLO", "10\" PEPPERONI", "10\" BOLOGNESE"].map((n, i) => opt(`t${i}`, n));
const TWELVE = ["12\" SWEET CHILLI KEBAB", "12\" QUINDICI", "12\" MEAT SUPREME"].map((n, i) => opt(`w${i}`, n));
const BURGERS = ["1/4 CHICKEN BURGER", "1/4 CHEESE BURGER", "1/4 BEEF BURGER"].map((n, i) => opt(`b${i}`, n));
const DIPS = [opt("d0", "+garlic dip"), opt("d1", "+garlic dip")];

// As the shop actually set it up: burgers choose 3 of 3, duplicates off.
const MEGA = {
  id: "mega",
  name: "MEGA BOX",
  price: 28.5,
  categoryName: "Deals",
  modifierGroups: [
    G("g10", "SELECT YOUR 10\" PIZZA", TEN),
    G("g12", "SELECT YOUR 12\" PIZZA", TWELVE),
    G("gb", "SELECT YOUR BURGERS", BURGERS, { min: 3, max: 3, selectionType: "ADDON", repeats: false }),
    G("gs", "SELECT YOUR SAUCES", DIPS, { min: 2, max: 2, selectionType: "ADDON", repeats: false }),
  ],
};

describe("twin options are one option to the matcher", () => {
  it("folds two rows with the same name into one", () => {
    expect(uniqueByName(DIPS).map((o) => o.id)).toEqual(["d0"]);
  });

  it("'garlic dip' against two '+garlic dip' rows is a match, not a question", () => {
    const r = matchOptionResult("garlic dip", DIPS, "SELECT YOUR SAUCES");
    expect(r.kind).toBe("matched");
  });

  it("does not fold two DIFFERENT names, so a real tie is still a question", () => {
    expect(uniqueByName([opt("a", "12\" MEAT SUPREME"), opt("b", "12\" VEG SUPREME")])).toHaveLength(2);
  });
});

describe("what a dish comes with is not a question", () => {
  it("everything fits and nothing costs: included", () => {
    expect(includedGroup(MEGA.modifierGroups[2])).toBe(true); // three burgers, room for three
    expect(includedGroup(MEGA.modifierGroups[3])).toBe(true); // two dips, room for two
  });

  it("a pick-one among many is a real choice", () => {
    expect(includedGroup(MEGA.modifierGroups[0])).toBe(false);
  });

  it("a group that may repeat is a real choice even when everything fits — two cokes is an answer", () => {
    const g = G("d", "Drink", [opt("a", "CAN Coke"), opt("b", "CAN Sprite")], { min: 2, max: 2, selectionType: "ADDON", repeats: true });
    expect(includedGroup(g)).toBe(false);
  });

  it("choose 2 of 3 is a real choice", () => {
    const g = G("s", "Sauces", [opt("a", "Garlic"), opt("b", "Chilli"), opt("c", "BBQ")], { max: 2 });
    expect(includedGroup(g)).toBe(false);
  });

  it("anything with a price is never put on unasked", () => {
    const g = G("x", "Extras", [opt("a", "+cheese", 1.5), opt("b", "+garlic dip", 0)], { max: 2 });
    expect(includedGroup(g)).toBe(false);
  });

  it("a group of removals is never ticked in full — that would strip the dish", () => {
    const g = G("r", "Remove", [opt("a", "No onion"), opt("b", "No lettuce")], { max: 2, min: 0, required: false });
    expect(includedGroup(g)).toBe(false);
    const g2 = G("r2", "Without", [opt("a", "onion"), opt("b", "lettuce")], { max: 2, min: 0, required: false });
    expect(includedGroup(g2)).toBe(false);
  });

  it("no maximum written down means no room to reason about", () => {
    const g = G("m", "Sides", [opt("a", "Chips")], { max: 0, min: 0, required: false });
    expect(includedGroup(g)).toBe(false);
  });
});

describe("MEGA BOX over the phone", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const MENU: any[] = [MEGA];
  const c = () => {
    const x: any = { currency: "GBP", items: MENU, deliveryZones: [] };
    x.itemIndex = new Map(MENU.map((i) => [i.id, i]));
    x.optionIndex = new Map(
      MENU.flatMap((i: any) =>
        i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])),
      ),
    );
    return x;
  };
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const fresh = () => ({ cart: { items: [], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] }) as any;

  it("asks for the two pizzas only; burgers and dips go on by themselves and are named as included", () => {
    const a = ai();
    const st = fresh();
    const out = a.addItemConversational({ said: "mega box", modifierNames: ["pepperoni"] }, c(), st);
    expect(out.result).toMatch(/^NOT added yet\./);
    // The one real question, and only that one — no "burgers (…)" ask, no "sauces (…)" ask.
    expect(out.result).toMatch(/still needs a choice of: 12" pizza \(12 inch SWEET CHILLI KEBAB, 12 inch QUINDICI, 12 inch MEAT SUPREME\)\./);
    expect(out.result).not.toMatch(/burgers \(/);
    expect(out.result).not.toMatch(/sauces \(/);
    expect(out.result).toMatch(/Comes with \(already added, included in the price — say so, do not ask\): burgers: 1\/4 CHICKEN BURGER \+ 1\/4 CHEESE BURGER \+ 1\/4 BEEF BURGER; sauces: \+garlic dip ×2\./);
    // Both dip ROWS, not the same row twice.
    const dipRows = st.draft.picks.filter((p: any) => p.g === "gs").map((p: any) => p.o);
    expect(dipRows.sort()).toEqual(["d0", "d1"]);
    expect(st.draft.picks.filter((p: any) => p.g === "gb")).toHaveLength(3);
  });

  it("the second pizza finishes it, with all seven choices on the line", () => {
    const a = ai();
    const st = fresh();
    const ctx = c();
    a.addItemConversational({ said: "mega box", modifierNames: ["pepperoni"] }, ctx, st);
    const out = a.addItemConversational({ said: "quindici" }, ctx, st);
    expect(out.result).toMatch(/^Added 1 × MEGA BOX with 10" PEPPERONI, 12" QUINDICI, 1\/4 CHICKEN BURGER, 1\/4 CHEESE BURGER, 1\/4 BEEF BURGER, \+garlic dip, \+garlic dip — £28\.50\./);
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items[0].modifiers.map((m: any) => m.optionId).sort()).toEqual(["b0", "b1", "b2", "d0", "d1", "t2", "w1"]);
    expect(st.draft).toBeUndefined();
  });

  it("'two garlic sauce' said outright is both dips, and never a question", () => {
    const a = ai();
    const st = fresh();
    const out = a.addItemConversational(
      { said: "mega box", modifierNames: ["pepperoni", "quindici", "2 garlic sauce", "one of each burger"] },
      c(),
      st,
    );
    expect(out.result).not.toMatch(/could be/);
    expect(out.result).toMatch(/^Added 1 × MEGA BOX/);
    const dips = st.cart.items[0].modifiers.filter((m: any) => m.name === "+garlic dip");
    expect(dips.map((m: any) => m.optionId).sort()).toEqual(["d0", "d1"]);
  });

  // Order 9WHQ2: three cheese burgers on a ticket, from a group whose
  // duplicate box was not ticked.
  it("'three cheese burgers' in a one-of-each group is one cheese burger, and the caller is told", () => {
    const a = ai();
    const st = fresh();
    const out = a.addItemConversational(
      { said: "mega box", modifierNames: ["pepperoni", "quindici", "3 cheese burger"] },
      c(),
      st,
    );
    expect(out.result).toMatch(/^Added 1 × MEGA BOX/);
    expect(out.result).toMatch(/burgers takes one of each, so 1\/4 CHEESE BURGER is on once — tell them it is one of each only, do not try again\./);
    const burgers = st.cart.items[0].modifiers.filter((m: any) => /BURGER/.test(m.name)).map((m: any) => m.name).sort();
    expect(burgers).toEqual(["1/4 BEEF BURGER", "1/4 CHEESE BURGER", "1/4 CHICKEN BURGER"]);
  });

  it("a group with duplicates allowed still takes two of the same", () => {
    const { VoiceAiService: Svc } = require("../voice-ai.service");
    const DEAL = {
      id: "two",
      name: "TWO PIZZA DEAL",
      price: 18,
      categoryName: "Deals",
      modifierGroups: [G("tp", "Pizzas", [opt("m", "Margherita"), opt("p", "Pepperoni")], { min: 2, max: 2, selectionType: "ADDON", repeats: true })],
    };
    const ctx: any = { currency: "GBP", items: [DEAL], deliveryZones: [] };
    ctx.itemIndex = new Map([[DEAL.id, DEAL]]);
    ctx.optionIndex = new Map(DEAL.modifierGroups[0].options.map((o: any) => [o.id, { groupId: "tp", itemId: DEAL.id, option: o }]));
    const a: any = Object.create(Svc.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    const st = fresh();
    const out = a.addItemConversational({ said: "two pizza deal", modifierNames: ["two pepperoni"] }, ctx, st);
    expect(out.result).toMatch(/^Added 1 × TWO PIZZA DEAL with Pepperoni, Pepperoni/);
    expect(out.result).not.toMatch(/one of each/);
  });

  it("the ticket carries what was included, so the kitchen makes all of it", () => {
    const a = ai();
    const st = fresh();
    a.addItemConversational({ said: "mega box", modifierNames: ["pepperoni", "quindici"] }, c(), st);
    const names = st.cart.items[0].modifiers.map((m: any) => m.name);
    expect(names).toEqual(expect.arrayContaining(["1/4 CHICKEN BURGER", "1/4 CHEESE BURGER", "1/4 BEEF BURGER", "+garlic dip"]));
    expect(names.filter((n: string) => n === "+garlic dip")).toHaveLength(2);
  });
});
