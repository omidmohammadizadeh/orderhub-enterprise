// The size question that never ended.
//
// From a live call, three times in a row:
//
//   pressed 2
//   answered a choice with key 2      ← the keypress landed
//   calling add_item                  ← and the model re-added the pizza
//   said "For your select pizza size, press 1 for 10", 2 for 12"…"
//
// Every press worked. Six hundred milliseconds later add_item built a fresh
// pendingItem, threw away the size that had just been chosen, and asked for it
// again — so the caller answered the same question forever and eventually
// heard "something didn't go through correctly". The model cannot see that a
// walkthrough is being driven from code, so add_item has to refuse to restart
// one that is already open.

import { VoiceAiService } from "../voice-ai.service";

const PIZZA = {
  id: "pep",
  name: "Pepperoni Pizza",
  price: 9,
  modifierGroups: [
    {
      id: "size",
      name: "Select Pizza Size",
      required: false,
      min: 1,
      options: [
        { id: "z10", name: '10"', price: 0 },
        { id: "z12", name: '12"', price: 2 },
        { id: "z14", name: '14"', price: 4 },
      ],
    },
  ],
};
const MENU: any[] = [PIZZA, { id: "chips", name: "Chips", price: 3, modifierGroups: [] }];

const svc = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};
const ctx = () => {
  const c: any = { currency: "GBP", items: MENU };
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

describe("a walkthrough already running", () => {
  it("survives the model re-adding the same item after a keypress", () => {
    const s = svc();
    const c = ctx();
    const st = state();

    // The caller asks for a pepperoni pizza and is asked for the size.
    const first = s.addItem({ itemId: "pep" }, c, st);
    expect(first.sayNow).toBe(
      "Pepperoni Pizza comes with a choice of pizza size — 10 inch, 12 inch or 14 inch. Which would you like?",
    );

    // They press 2. This is the part that always worked.
    expect(s.chooseByNumber(c, st, "2")).toMatch(/12/);
    expect(st.pendingItem.chosen).toContain("z12");

    // And now the model, which never saw any of that, adds the pizza again.
    const again = s.addItem({ itemId: "pep" }, c, st);

    expect(again.sayNow).toBeUndefined();
    expect(again.result).toMatch(/Do not call add_item again/i);
    expect(st.pendingItem.chosen).toContain("z12"); // the size is still chosen
  });

  it("does not re-ask a question the caller is part way through", () => {
    const s = svc();
    const c = ctx();
    const st = state();
    s.addItem({ itemId: "pep" }, c, st);

    const again = s.addItem({ itemId: "pep" }, c, st);

    expect(again.sayNow).toBeUndefined();
    expect(again.result).toMatch(/ALREADY asked them this/i);
    expect(st.choices).toEqual(["z10", "z12", "z14"]); // the numbers still mean what they meant
  });

  it("refuses the re-add even when it carries the choices", () => {
    // Keyed on the walkthrough being open, not on what the model passed. A
    // re-add carrying the size does not restart anything — it adds a second
    // line and leaves the half-answered one open behind it, and the caller's
    // next keypress commits the duplicate.
    const s = svc();
    const c = ctx();
    const st = state();
    s.addItem({ itemId: "pep" }, c, st);

    const again = s.addItem({ itemId: "pep", modifierOptionIds: ["z12"] }, c, st);

    expect(st.cart.items).toHaveLength(0);
    expect(again.result).toMatch(/Do not call add_item again/i);
  });

  it("still lets a different dish be added mid-walkthrough", () => {
    const s = svc();
    const c = ctx();
    const st = state();
    s.addItem({ itemId: "pep" }, c, st);

    const chips = s.addItem({ itemId: "chips" }, c, st);

    expect(chips.result).not.toMatch(/Do not call add_item again/i);
  });

  it("lets the same dish be ordered again once the first one is committed", () => {
    const s = svc();
    const c = ctx();
    const st = state();
    s.addItem({ itemId: "pep" }, c, st);
    s.chooseByNumber(c, st, "2");
    s.answerItemNote(c, st, "no jalapenos");
    expect(st.cart.items).toHaveLength(1);

    const second = s.addItem({ itemId: "pep" }, c, st);
    expect(second.sayNow).toMatch(/choice of pizza size — 10 inch/);
  });
});
