import { matchOptionResult } from "../voice-menu-match";

// Call l3fkZXKA, AMERICAN SHARE BOX: one choice, a 12" pizza. The model offered
// a drink the box has never come with; "bottle Fanta" then matched 12" LITTLE
// ITALY and replaced the Margherita already chosen; and re-sending the box to
// attach the drink added a second £25 box.

const PIZZAS = ['12" SWEET CHILLI KEBAB', '12" GRAN DUCA', '12" KEBAB PIZZA', '12" QUINDICI', '12" MARGHERITA ', '12" LITTLE ITALY', '12" PEPPERONI'];
const opts = PIZZAS.map((n, i) => ({ id: `p${i}`, name: n, price: 0 }));
const GROUP = 'SELECT YOUR 12" PIZZA';

describe("a partial match needs a word the caller really said", () => {
  it("'bottle Fanta' is no pizza", () => {
    expect(matchOptionResult("bottle Fanta", opts, GROUP).kind).toBe("none");
    expect(matchOptionResult("bottle of Santa", opts, GROUP).kind).toBe("none");
  });

  it("a shortened name said literally still matches", () => {
    const r: any = matchOptionResult("marg", opts, GROUP);
    expect(r.kind).toBe("matched");
    expect(r.item.name).toBe('12" MARGHERITA ');
  });

  it("one real word of a two-word name still matches", () => {
    const r: any = matchOptionResult("little", opts, GROUP);
    expect(r.kind).toBe("matched");
    expect(r.item.name).toBe('12" LITTLE ITALY');
  });

  it("a whole name misheard by sound still matches", () => {
    const r: any = matchOptionResult("peperoni", opts, GROUP);
    expect(r.kind).toBe("matched");
    expect(r.item.name).toBe('12" PEPPERONI');
  });
});

describe("AMERICAN SHARE BOX over the phone", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const BOX = {
    id: "box",
    name: "AMERICAN SHARE BOX",
    price: 25,
    categoryName: "MEAL DEALS",
    description: '12" PIZZA OF YOUR CHOICE, 2 X HOT DOGS, 2 X BURGER, CHIPS, GARLIC, CHILLI',
    modifierGroups: [{ id: "gp", name: GROUP, required: true, min: 1, max: 1, selectionType: "VARIANT", options: opts }],
  };
  const COKE = { id: "coke", name: "CAN COKE", price: 1.5, categoryName: "DRINKS", modifierGroups: [] };
  const MENU: any[] = [BOX, COKE];
  const ctx = () => {
    const x: any = { currency: "GBP", items: MENU, deliveryZones: [] };
    x.itemIndex = new Map(MENU.map((i) => [i.id, i]));
    x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]))));
    return x;
  };
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const fresh = () => ({ cart: { items: [], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] }) as any;
  const pizzaOf = (st: any, i = 0) => st.cart.items[i].modifiers.map((m: any) => m.name);

  it("a drink sent with the pizza keeps the pizza, and is told plainly it is not part of the box", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita", "bottle Fanta"] }, ctx(), st);
    expect(out.result).toMatch(/^Added 1 × AMERICAN SHARE BOX with 12" MARGHERITA/);
    expect(pizzaOf(st)).toEqual(['12" MARGHERITA ']);
    expect(out.result).toMatch(/"bottle Fanta" matches none of the AMERICAN SHARE BOX's choices, so it is not part of the AMERICAN SHARE BOX\. Never describe the AMERICAN SHARE BOX as coming with it/);
    expect(out.result).not.toMatch(/could not place/);
  });

  it("re-sending the box only to attach a drink does not add a second box", () => {
    const a = ai(); const st = fresh(); const c = ctx();
    a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita", "can Coke"] }, c, st);
    st.__lastAdd.at -= 15_000; // fifteen seconds later, as on the call
    const again = a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita", "Fanta"] }, c, st);
    expect(again.result).toMatch(/^Already on the order — that AMERICAN SHARE BOX was added a moment ago\. Not adding it again\./);
    expect(again.result).toMatch(/"Fanta" matches none of the AMERICAN SHARE BOX's choices/);
    expect(st.cart.items).toHaveLength(1);
  });

  it("a genuine second box, with nothing extra attached, is still added", () => {
    const a = ai(); const st = fresh(); const c = ctx();
    a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita"] }, c, st);
    st.__lastAdd.at -= 15_000;
    a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita"] }, c, st);
    expect(st.cart.items).toHaveLength(2);
  });

  it("a weaker match in the same request never replaces a clearer choice", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita", "little"] }, ctx(), st);
    expect(pizzaOf(st)).toEqual(['12" MARGHERITA ']);
    expect(out.result).toMatch(/"little" matches none of the AMERICAN SHARE BOX's choices/);
  });

  it("a caller correcting themselves just as clearly still gets the new choice", () => {
    const a = ai(); const st = fresh();
    a.addItemConversational({ said: "American Share Box", modifierNames: ["Margherita", "Pepperoni"] }, ctx(), st);
    expect(pizzaOf(st)).toEqual(['12" PEPPERONI']);
  });
});
