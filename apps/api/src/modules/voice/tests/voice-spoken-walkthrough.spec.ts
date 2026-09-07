// The pizza that never reached the basket.
//
// 7 September, 14:11 — a Gran Duca, 12", deep pan, both chosen on the keypad:
//
//   said "deep pan. Any notes for the gran duca — anything like no onions or
//         extra sauce? Say it now, or press 1 if not."
//   heard "No."
//   tool add_item → "already being dealt with … going into the basket"
//   tool add_item → "Added 2 × CHIPS"
//   [ten seconds of silence, then the watchdog]
//
// The order that went to the kitchen was chips, garlic sauce and Coke. No
// pizza. Pressing 1 was routed and answered; SAYING "no" was routed nowhere,
// so the item sat in pendingItem forever — and the model, told the item was
// being handled somewhere it could not see, said nothing at all.
//
// The walkthrough has to hear a spoken answer exactly as well as a pressed one.

import { VoiceService } from "../voice.service";
import { VoiceAiService } from "../voice-ai.service";

const PIZZA = {
  id: "gd",
  name: "GRAN DUCA",
  price: 12,
  modifierGroups: [
    {
      id: "size",
      name: "Select Pizza Size",
      required: false,
      min: 1,
      options: [
        { id: "z10", name: '10"', price: 0 },
        { id: "z12", name: '12"', price: 2 },
      ],
    },
  ],
};
const MENU: any[] = [PIZZA];

const ai = () => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  return a;
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

/** A call sitting exactly where the live one was: size chosen, note asked. */
const atTheNoteQuestion = () => {
  const a = ai();
  const c = ctx();
  const state: any = { cart: { items: [] }, turns: [] };
  a.addItem({ itemId: "gd" }, c, state);
  a.chooseByNumber(c, state, "2"); // 12" — this also asks for notes
  expect(state.pendingItem.notesAsked).toBe(true);
  expect(state.cart.items).toHaveLength(0); // not in the basket yet
  return { a, c, state };
};

const svc = (a: any, c: any, state: any) => {
  const s: any = Object.create(VoiceService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.ai = a;
  s.save = async () => {};
  // answerSlot persists before it returns; without this the stub throws after
  // the cart has already moved.
  s.db = () => ({ voiceCall: { update: async () => {} } });
  s.loadByControlId = async () => ({ call: { id: "c1" }, ctx: c, state });
  return s;
};

describe("a walkthrough question answered out loud", () => {
  it("puts the pizza in the basket when they SAY no", async () => {
    const { a, c, state } = atTheNoteQuestion();
    const s = svc(a, c, state);

    const out = await s.realtimeSaid("cc1", "No.");

    expect(out?.say).toBeTruthy();
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].name).toMatch(/GRAN DUCA/i);
    expect(state.pendingItem).toBeUndefined();
  });

  it("keeps a real note against the line", async () => {
    const { a, c, state } = atTheNoteQuestion();
    const s = svc(a, c, state);

    await s.realtimeSaid("cc1", "no onions please");

    expect(state.cart.items).toHaveLength(1);
    expect(JSON.stringify(state.cart.items[0])).toMatch(/no onions/i);
  });

  it("answers a numbered choice spoken instead of pressed", async () => {
    const a = ai();
    const c = ctx();
    const state: any = { cart: { items: [] }, turns: [] };
    a.addItem({ itemId: "gd" }, c, state);
    const s = svc(a, c, state);

    const out = await s.realtimeSaid("cc1", "twelve inch");

    expect(out?.say).toBeTruthy();
    expect(state.pendingItem.chosen).toContain("z12");
  });

  it("hands anything else back to the model", async () => {
    // The slot is a shortcut for the answer we asked for, never a trap for a
    // caller who changed the subject.
    const { a, c, state } = atTheNoteQuestion();
    const s = svc(a, c, state);
    // Nothing is pending on this call at all.
    const idle: any = { cart: { items: [] }, turns: [] };
    s.loadByControlId = async () => ({ call: { id: "c1" }, ctx: c, state: idle });

    expect(await s.realtimeSaid("cc1", "actually can I add a coke")).toBeNull();
  });

  it("ignores an empty transcript rather than writing it down as a note", async () => {
    // A cough during "any notes?" must not become the note.
    const { a, c, state } = atTheNoteQuestion();
    const s = svc(a, c, state);

    expect(await s.realtimeSaid("cc1", "   ")).toBeNull();
    expect(state.cart.items).toHaveLength(0);
    expect(state.pendingItem).toBeTruthy(); // still waiting for a real answer
  });
});

describe("numbers are the reliable part of a transcript", () => {
  const m = require("../voice-menu-match");
  const SIZES = [{ id: "z10", name: '10"' }, { id: "z12", name: '12"' }, { id: "z14", name: '14"' }];

  it("keeps digits when folding a word", () => {
    // soundFold("12") used to be "" — so every numeric option on a menu folded
    // to the same empty string and scored identically against anything. On a
    // pizza menu that is the size list, which made 10" and 12" the same option
    // as far as the matcher was concerned.
    expect(m.soundFold("12")).toContain("12");
    expect(m.soundFold("12")).not.toBe(m.soundFold("10"));
  });

  it("tells one size from another", () => {
    for (const [said, want] of [
      ["12 inch", '12"'],
      ['12"', '12"'],
      ["10 inch", '10"'],
      ["twelve inch", '12"'],
      ["fourteen", '14"'],
    ] as const) {
      expect(m.matchOption(said, SIZES, "Select Pizza Size")?.item.name).toBe(want);
    }
  });

  it("still refuses a size nobody offered", () => {
    // Wrong food beats no food only in the other direction: an unmatched size
    // is a question, an invented one is the wrong pizza.
    expect(m.matchOption("sixteen inch", SIZES, "Select Pizza Size")).toBeNull();
    expect(m.matchOption("large", SIZES, "Select Pizza Size")).toBeNull();
  });

  it("does not rewrite numbers inside dish names", () => {
    // Only the caller's words are converted. "Four Meat" and "Uno" stay put.
    const dishes = [{ id: "a", name: "Four Meat" }, { id: "b", name: "Meat Feast" }];
    expect(m.matchOption("four meat", dishes, "Pizza")?.item.name).toBe("Four Meat");
  });
});
