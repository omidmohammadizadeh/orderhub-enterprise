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
  { id: "m10", name: 'Margherita (10")', price: 8, categoryName: "Pizzas", modifierGroups: [] },
  { id: "m14", name: 'Margherita (14")', price: 12, categoryName: "Pizzas", modifierGroups: [] },
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
      {
        id: "sauce",
        name: "Sauce",
        required: true,
        min: 1,
        options: [
          { id: "s1", name: "Chilli", price: 0 },
          { id: "s2", name: "Garlic", price: 0 },
        ],
      },
    ],
  },
  {
    id: "ckebab",
    name: "Chicken Kebab",
    price: 6.5,
    modifierGroups: [
      {
        id: "sauce2",
        name: "Sauce",
        required: true,
        min: 1,
        options: [{ id: "s3", name: "Chilli", price: 0 }],
      },
    ],
  },
];

const svc = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};
const ctx = () => ({ currency: "GBP", items: MENU }) as any;
/** With the indexes the option and size flows need. */
const ctxSized = () => {
  const c: any = ctx();
  c.itemIndex = new Map(MENU.map((i: any) => [i.id, i]));
  c.optionIndex = new Map(
    MENU.flatMap((i: any) =>
      (i.modifierGroups ?? []).flatMap((g: any) =>
        g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]),
      ),
    ),
  );
  return c;
};
const state = () => ({ cart: { items: [] }, turns: [] }) as any;

const add = (said: string) => {
  const st = state();
  const out = svc().quickAddAloud(ctx(), st, said);
  return { say: out?.say ?? null, next: out?.next, state: st, cart: st.cart.items };
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

describe("saying it the short way", () => {
  it("understands an abbreviation", () => {
    // "a large marg" is what people actually say. Four characters is the floor
    // — shorter and "gar" starts matching garlic bread and garlic mayo at once.
    const { cart } = add("large marg");
    expect(cart[0]).toMatchObject({ itemId: "m14" });
  });

  it("understands the category said out loud", () => {
    // The menu calls it "Margherita"; the caller says "margherita pizza".
    const st = state();
    const out = svc().quickAddAloud(ctxSized(), st, "a large margarita pizza");
    expect(st.cart.items[0]).toMatchObject({ itemId: "m14" });
    expect(out.say).toMatch(/anything else/i);
  });
});

describe("a dish whose size they did not say", () => {
  it("asks which, rather than handing it over", () => {
    // The DISH is certain and only the size is open. That is a better question
    // than the model's, because it reads "10 or 14 inch" instead of three
    // near-identical menu rows.
    const st = state();
    const out = svc().quickAddAloud(ctxSized(), st, "a margherita");
    expect(out.say).toBe("What size Margherita would you like — 10 inch or 14 inch?");
    expect(out.next).toBe("ITEM_OPTION");
    expect(st.cart.items).toHaveLength(0);
  });

  it("takes the answer", () => {
    const c = ctxSized();
    const st = state();
    svc().quickAddAloud(c, st, "two margheritas");
    const say = svc().answerItemOption(c, st, "large");
    expect(say).toContain("Margherita, 14 inch");
    expect(st.cart.items[0]).toMatchObject({ itemId: "m14", quantity: 2 });
  });

  it("keeps the size question out of a multi-item burst", () => {
    // Two open questions at once is a conversation, not a form.
    const st = state();
    expect(svc().quickAddAloud(ctxSized(), st, "a margherita and a garlic bread")).toBeNull();
    expect(st.cart.items).toHaveLength(0);
  });
});

describe("what it refuses to touch", () => {
  const refuses = (said: string) => {
    const st = state();
    expect(svc().quickAddAloud(ctx(), st, said)).toBeNull();
    // And nothing must be half-added on the way to that decision.
    expect(st.cart.items).toHaveLength(0);
  };

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

  it("leaves a burst where several dishes each need a choice to the model", () => {
    // Two questions owed at once is a conversation, not a form.
    refuses("a doner kebab and a chicken kebab");
  });
});

describe("a dish that needs a choice made about it", () => {
  // Most of a real takeaway menu has one — which sauce, which base, which
  // side. Sending every one of those to the model made the fast path apply to
  // drinks and little else.
  const ctxWithIndex = () => {
    const c: any = ctx();
    c.itemIndex = new Map(MENU.map((i) => [i.id, i]));
    c.optionIndex = new Map(
      MENU.flatMap((i: any) =>
        (i.modifierGroups ?? []).flatMap((g: any) =>
          g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]),
        ),
      ),
    );
    return c;
  };

  it("asks the question itself instead of handing it over", () => {
    const st = state();
    const out = svc().quickAddAloud(ctxWithIndex(), st, "a doner kebab");
    expect(out.say).toMatch(/which sauce/i);
    expect(out.next).toBe("ITEM_OPTION");
    expect(st.cart.items).toHaveLength(0);
    expect(st.pendingItem).toMatchObject({ itemId: "kebab", quantity: 1 });
  });

  it("takes the answer and adds the dish", () => {
    const c = ctxWithIndex();
    const st = state();
    svc().quickAddAloud(c, st, "a doner kebab");

    const say = svc().answerItemOption(c, st, "chilli please");
    expect(say).toMatch(/chilli/i);
    expect(say).toMatch(/anything else/i);
    expect(st.pendingItem).toBeUndefined();
    expect(st.cart.items[0]).toMatchObject({ itemId: "kebab" });
    expect(st.cart.items[0].modifiers[0]).toMatchObject({ name: "Chilli" });
  });

  it("does not ask for something they already said", () => {
    // "A doner with chilli sauce" answers the question in the same breath it
    // asks for the dish. Asking it back is how a line feels like a form.
    const c = ctxWithIndex();
    const st = state();
    const out = svc().quickAddAloud(c, st, "a doner kebab with chilli");
    expect(out.say).toMatch(/anything else/i);
    expect(st.cart.items[0].modifiers[0]).toMatchObject({ name: "Chilli" });
  });

  it("hands an unreadable answer to the model rather than guessing a sauce", () => {
    const c = ctxWithIndex();
    const st = state();
    svc().quickAddAloud(c, st, "a doner kebab");
    expect(svc().answerItemOption(c, st, "erm hang on")).toBeNull();
    expect(st.cart.items).toHaveLength(0);
  });
});
