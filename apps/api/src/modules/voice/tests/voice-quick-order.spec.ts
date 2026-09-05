// Adding food without paying for a model round trip.
//
// From a live call: after the address was settled, EVERY ordering turn came
// back "handled=model" and took five to eight seconds. On the part of the call
// with the most turns in it. But "three cokes and a garlic bread" needs no
// reasoning — the matcher already knows which dish that is, and it is the same
// matcher the model's own add_item goes through. The model was being paid to
// relay.

import { VoiceAiService } from "../voice-ai.service";

const MENU = [
  { id: "m10", name: 'Margherita (10")', price: 8, modifierGroups: [] },
  { id: "m14", name: 'Margherita (14")', price: 12, modifierGroups: [] },
  { id: "gb", name: "Garlic Bread", price: 4, modifierGroups: [] },
  { id: "coke", name: "Coca-Cola 330ml", price: 1.5, modifierGroups: [] },
  { id: "fries", name: "French Fries", price: 3, modifierGroups: [] },
  { id: "cb", name: "Chicken Burger", price: 7, modifierGroups: [] },
  { id: "cw", name: "Chicken Wrap", price: 7, modifierGroups: [] },
  {
    id: "kebab",
    name: "Doner Kebab",
    price: 6,
    modifierGroups: [
      { id: "sauce", name: "Sauce", required: true, min: 1, options: [{ id: "s1", name: "Chilli" }] },
    ],
  },
];

const svc = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};
const ctx = () => ({ currency: "GBP", items: MENU }) as any;
const state = () => ({ cart: { items: [] }, turns: [] }) as any;

const add = (said: string) => {
  const st = state();
  const say = svc().quickAddAloud(ctx(), st, said);
  return { say, cart: st.cart.items };
};

describe("adding food in code", () => {
  it("takes a whole burst in one turn", () => {
    const { say, cart } = add("three cokes and a garlic bread");
    expect(cart).toHaveLength(2);
    expect(cart[0]).toMatchObject({ name: "Coca-Cola 330ml", quantity: 3 });
    expect(cart[1]).toMatchObject({ name: "Garlic Bread", quantity: 1 });
    expect(say).toContain("3 Coca-Cola 330ml");
    expect(say).toContain("and Garlic Bread");
    expect(say).toMatch(/anything else/i);
  });

  it("resolves the size the caller said", () => {
    const { say, cart } = add("a large margherita");
    expect(cart[0]).toMatchObject({ itemId: "m14" });
    // Said, not printed. Nobody reads 'Margherita (14")' out loud.
    expect(say).toContain("Margherita, 14 inch");
    expect(say).not.toContain('(14")');
  });

  it("understands what people call things", () => {
    expect(add("chips").cart[0]).toMatchObject({ name: "French Fries" });
  });

  it("strips the politeness people actually say", () => {
    expect(add("can I get a garlic bread").cart[0]).toMatchObject({ name: "Garlic Bread" });
  });
});

describe("what it refuses to touch", () => {
  const refuses = (said: string) => {
    const st = state();
    expect(svc().quickAddAloud(ctx(), st, said)).toBeNull();
    // And nothing must be half-added on the way to that decision.
    expect(st.cart.items).toHaveLength(0);
  };

  it("leaves a dish needing a required choice to the model", () => {
    // Asking "which sauce?" well is exactly what the model is for.
    refuses("a doner kebab");
  });

  it("adds nothing at all when one item in the burst is unclear", () => {
    // Half an order added behind the caller's back is worse than a slow turn.
    refuses("a garlic bread and some chicken");
  });

  it("leaves changes, removals and questions alone", () => {
    refuses("actually remove the garlic bread");
    refuses("can I change that to a large one");
    refuses("how much is the garlic bread?");
    refuses("no onions on the margherita");
  });

  it("leaves finishing an order alone", () => {
    refuses("that's it thanks");
    refuses("that's all");
  });

  it("does not treat a bare yes as a dish", () => {
    refuses("yes");
  });

  it("says nothing about a menu it does not have", () => {
    const st = state();
    expect(svc().quickAddAloud({ currency: "GBP", items: [] } as any, st, "chips")).toBeNull();
  });
});
