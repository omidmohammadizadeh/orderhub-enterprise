// The same dish must ask the same question, whichever path reached it.
//
// From a live call: "solo meal" was matched in code and the caller heard
// "press 1 for Gyros Wrap, 2 for Halloumi Wrap". The same dish said in a way
// the matcher was less sure of went to the model instead, which asked in its
// own words — no numbers, and a keypad that did nothing, because nothing had
// recorded what 1 and 2 meant. Two lines, one shop, and the difference was
// invisible from the outside.

import { VoiceAiService } from "../voice-ai.service";
import { VoiceService } from "../voice.service";

const KEBAB = {
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
};
const MENU: any[] = [KEBAB, { id: "gb", name: "Garlic Bread", price: 4, modifierGroups: [] }];

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
const runTool = (s: any, c: any, st: any, input: any) =>
  (s as any).addItem(input, c, st);

describe("a dish the model added, not the matcher", () => {
  it("asks the same numbered question the matcher would have", () => {
    const s = svc();
    const c = ctx();
    const st = state();
    const out = runTool(s, c, st, { itemId: "kebab" });

    expect(out.sayNow).toBe("Doner Kebab comes with a choice of sauce — Chilli or Garlic. Which would you like?");
    expect(st.choices).toEqual(["s1", "s2"]);
    expect(st.pendingItem).toMatchObject({ itemId: "kebab", quantity: 1 });
    expect(st.cart.items).toHaveLength(0);
  });

  it("says it verbatim rather than letting the model retell it", () => {
    // The numbers only mean anything if the words the caller hears are the
    // words that were recorded against them.
    const out = runTool(svc(), ctx(), state(), { itemId: "kebab" });
    expect(out.sayNow).toContain("Chilli or Garlic. Which would you like?");
    expect(out.result).toMatch(/handled in code, so say nothing more/);
  });

  it("hands the answer to the keypad and to speech alike", () => {
    const s = svc();
    const c = ctx();
    const st = state();
    runTool(s, c, st, { itemId: "kebab" });

    expect(s.chooseByNumber(c, st, "2")).toMatch(/Any notes for the doner kebab/i);
    expect(st.pendingItem.chosen).toEqual(["s2"]);
    expect(s.answerItemNote(c, st, "no")).toMatch(/Doner Kebab/);
    expect(st.cart.items[0].modifiers[0]).toMatchObject({ name: "Garlic" });
  });

  it("keeps the quantity and any note the model already had", () => {
    const st = state();
    runTool(svc(), ctx(), st, { itemId: "kebab", quantity: 3, notes: "well done" });

    expect(st.pendingItem.quantity).toBe(3);
    expect(st.pendingItem.notes).toBe("well done");
    // Already noted, so they are not asked for one a second time.
    expect(st.pendingItem.notesAsked).toBe(true);
  });

  it("adds a dish with nothing outstanding straight away", () => {
    const st = state();
    const out = runTool(svc(), ctx(), st, { itemId: "gb", quantity: 2 });

    expect(out.sayNow).toBeUndefined();
    expect(st.cart.items).toHaveLength(1);
    expect(st.pendingItem).toBeUndefined();
  });

  it("adds it without asking when the model already chose", () => {
    const st = state();
    runTool(svc(), ctx(), st, { itemId: "kebab", modifierOptionIds: ["s1"] });
    expect(st.cart.items[0].modifiers[0]).toMatchObject({ name: "Chilli" });
    expect(st.pendingItem).toBeUndefined();
  });
});

describe("after a model turn", () => {
  it("marks the question as one code now owns", () => {
    // Without this the caller's answer went back to the model and their
    // keypress landed on nothing at all.
    const v: any = Object.create(VoiceService.prototype);
    const st: any = { cart: { items: [] }, turns: [], choices: ["s1", "s2"] };
    st.pendingItem = { itemId: "kebab", quantity: 1, chosen: [] };

    expect(v.pendingSlot(st)).toBe("ITEM_OPTION");
    st.choices = undefined;
    st.pendingItem.notesAsked = true;
    expect(v.pendingSlot(st)).toBe("ITEM_NOTE");
    st.pendingItem = undefined;
    expect(v.pendingSlot(st)).toBeUndefined();
  });
});

it("still refuses rather than adding a dish with an unanswered choice", () => {
  // The guard this replaced: whatever goes wrong building the question, a
  // kebab with no sauce chosen must never reach the kitchen.
  const s = svc();
  const c = ctx();
  const st = state();
  s.askNextOption = () => null;
  const out = (s as any).addItem({ itemId: "kebab" }, c, st);

  expect(out.sayNow).toBeUndefined();
  expect(out.result).toMatch(/must ask which Sauce/);
  expect(st.cart.items).toHaveLength(0);
  expect(st.pendingItem).toBeUndefined();
});
