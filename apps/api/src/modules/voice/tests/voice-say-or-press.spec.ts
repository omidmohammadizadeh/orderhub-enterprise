// Answering a question by saying it OR by pressing a number.
//
// The alternative, and what a phone tree would do, is read the numbers out:
// "for gyros wrap press 1, halloumi press 2, souvlaki press 3" is about seven
// seconds against two and a half for asking it like a person. A Solo Meal has
// three of those questions, so the phone-tree version of one meal is roughly
// twenty-seven seconds against twelve — and a regular who orders the same
// thing every Friday pays it every Friday.
//
// So the numbers are never read out, and they are always live. Speaking costs
// nothing extra; pressing works on a line too poor to transcribe; and the slow
// numbered version is kept for the one caller the matcher has already failed
// twice, who is the only person it actually helps.

import { VoiceAiService } from "../voice-ai.service";

const MENU = [
  {
    id: "solo",
    name: "Solo Meal",
    price: 9.5,
    modifierGroups: [
      {
        id: "wrap",
        name: "Wrap",
        required: true,
        min: 1,
        options: [
          { id: "w1", name: "Gyros Wrap", price: 0 },
          { id: "w2", name: "Halloumi Wrap", price: 0 },
          { id: "w3", name: "Souvlaki Wrap", price: 0 },
        ],
      },
      {
        id: "side",
        name: "Side",
        required: true,
        min: 1,
        options: [
          { id: "f1", name: "Oregano Fries", price: 0 },
          { id: "f2", name: "Olives", price: 0 },
          { id: "f3", name: "Halloumi Fries", price: 0 },
        ],
      },
      {
        id: "drink",
        name: "Drink",
        required: true,
        min: 1,
        options: [
          { id: "d1", name: "Coke", price: 0 },
          { id: "d2", name: "Diet Coke", price: 0 },
        ],
      },
    ],
  },
  { id: "gb", name: "Garlic Bread", price: 4, modifierGroups: [] },
];

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

/** A call that has just asked for a Solo Meal. */
const ordering = () => {
  const s = svc();
  const c = ctx();
  const st: any = { cart: { items: [] }, turns: [] };
  const out = s.quickAddAloud(c, st, "a solo meal");
  return { s, c, st, say: out?.say ?? "" };
};

describe("the question a caller hears", () => {
  it("is asked like a person, not like a phone tree", () => {
    const { say } = ordering();
    expect(say).toMatch(/Which wrap would you like — Gyros Wrap, Halloumi Wrap or Souvlaki Wrap\?/);
    expect(say).not.toMatch(/press 1 for/i);
  });

  it("mentions the keypad once in a call and then never again", () => {
    const { s, c, st, say } = ordering();
    expect(say).toMatch(/Say it, or press 1, 2, 3\./);

    const second = s.answerItemOption(c, st, "gyros");
    expect(second).toMatch(/Which side/);
    expect(second).not.toMatch(/Say it, or press/);
  });

  it("leaves the numbers standing even though it never says them", () => {
    const { st } = ordering();
    expect(st.choices).toEqual(["w1", "w2", "w3"]);
  });
});

describe("pressing a number instead of saying it", () => {
  it("takes the option in the order they were read out", () => {
    const { s, c, st } = ordering();
    const say = s.chooseByNumber(c, st, "2");

    expect(st.pendingItem.chosen).toEqual(["w2"]);
    expect(say).toMatch(/Which side/);
    expect(st.choices).toEqual(["f1", "f2", "f3"]);
  });

  it("carries a whole meal through on the keypad alone", () => {
    const { s, c, st } = ordering();
    s.chooseByNumber(c, st, "1"); // Gyros Wrap
    s.chooseByNumber(c, st, "1"); // Oregano Fries
    const done = s.chooseByNumber(c, st, "2"); // Diet Coke

    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual([
      "Gyros Wrap",
      "Oregano Fries",
      "Diet Coke",
    ]);
    expect(done).toMatch(/Solo Meal/);
    // Nothing is on offer once the dish is in the cart, so a stray keypress
    // afterwards cannot silently add a modifier to it.
    expect(st.choices).toBeUndefined();
    expect(st.pendingItem).toBeUndefined();
  });

  it("mixes freely with speaking", () => {
    const { s, c, st } = ordering();
    s.answerItemOption(c, st, "halloumi wrap");
    s.chooseByNumber(c, st, "2"); // Olives
    s.answerItemOption(c, st, "diet coke");

    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual([
      "Halloumi Wrap",
      "Olives",
      "Diet Coke",
    ]);
  });

  it("ignores a key that means nothing here", () => {
    // Two options on offer and the caller pressed 7. Guessing would put a
    // drink they never chose on the order; the honest answer is to carry on
    // and let them say it.
    const { s, c, st } = ordering();
    s.chooseByNumber(c, st, "1");
    s.chooseByNumber(c, st, "1");
    expect(s.chooseByNumber(c, st, "7")).toBeNull();
    expect(st.pendingItem.chosen).toEqual(["w1", "f1"]);
  });

  it("never treats a size question's number as a modifier", () => {
    const { s, c, st } = ordering();
    expect(s.chooseByNumber(c, st, "0")).toBeNull();
  });
});

describe("when the matcher has failed the same caller twice", () => {
  it("gives up on charm and reads the numbers out", () => {
    // The only moment the seven seconds are worth paying: this caller has now
    // answered twice and been misheard twice, and a third friendly asking is
    // the same failure in a nicer voice.
    const { s, c, st } = ordering();
    expect(s.answerItemOption(c, st, "the gyros one please")).toBeTruthy();

    // Now the side question, twice misheard.
    expect(s.answerItemOption(c, st, "mmm")).toBeNull();
    expect(s.answerItemOption(c, st, "the erm")).toBeNull();
    expect(st.pendingItem.misses).toBe(2);

    const ask = s.askNextOption(c, st);
    expect(ask.say).toBe(
      "Sorry — let's do it by keypad. Which side: for Oregano Fries press 1, for Olives press 2, for Halloumi Fries press 3.",
    );
  });

  it("forgets the misses once something lands", () => {
    const { s, c, st } = ordering();
    s.answerItemOption(c, st, "mmm");
    expect(st.pendingItem.misses).toBe(1);
    s.chooseByNumber(c, st, "1");
    expect(st.pendingItem.misses).toBe(0);
  });
});

describe("what survives being written to the database and read back", () => {
  it("keeps what is on offer, so a keypress after a reload still lands", () => {
    const { st } = ordering();
    const { coerceState } = require("../voice-ai.service");
    const back = coerceState(JSON.parse(JSON.stringify(st)));

    expect(back.choices).toEqual(["w1", "w2", "w3"]);
    expect(back.toldAboutKeypad).toBe(true);
    expect(back.pendingItem.misses).toBe(0);
  });
});

describe("answering a question with the one word that matters", () => {
  const { matchOption } = require("../voice-menu-match");
  const WRAPS = [
    { id: "w1", name: "Gyros Wrap" },
    { id: "w2", name: "Halloumi Wrap" },
    { id: "w3", name: "Souvlaki Wrap" },
  ];
  const SIDES = [
    { id: "f1", name: "Oregano Fries" },
    { id: "f2", name: "Olives" },
    { id: "f3", name: "Halloumi Fries" },
  ];
  const DRINKS = [
    { id: "d1", name: "Coke" },
    { id: "d2", name: "Diet Coke" },
  ];
  const pick = (said: string, opts: any[], group: string) =>
    matchOption(said, opts, group)?.item?.name ?? null;

  it("does not make them repeat the word they were just asked", () => {
    // "Which wrap?" — "gyros". Nobody says "gyros wrap" here, and scoring it
    // as half a name is what sent this to the model and asked again.
    expect(pick("gyros", WRAPS, "Wrap")).toBe("Gyros Wrap");
    expect(pick("souvlaki", WRAPS, "Wrap")).toBe("Souvlaki Wrap");
    expect(pick("halloumi", WRAPS, "Wrap")).toBe("Halloumi Wrap");
  });

  it("still understands them saying the whole thing", () => {
    expect(pick("gyros wrap", WRAPS, "Wrap")).toBe("Gyros Wrap");
    expect(pick("the gyros one please", WRAPS, "Wrap")).toBe("Gyros Wrap");
  });

  it("takes half a name nobody else shares", () => {
    expect(pick("halloumi", SIDES, "Side")).toBe("Halloumi Fries");
    expect(pick("olives", SIDES, "Side")).toBe("Olives");
    expect(pick("oregano", SIDES, "Side")).toBe("Oregano Fries");
  });

  it("hears the difference between Coke and Diet Coke", () => {
    // Both score a perfect 1 for "diet coke" — Coke by having its whole name
    // covered. The answer is the one that accounts for what they said.
    expect(pick("diet coke", DRINKS, "Drink")).toBe("Diet Coke");
    expect(pick("coke", DRINKS, "Drink")).toBe("Coke");
    expect(pick("diet", DRINKS, "Drink")).toBe("Diet Coke");
  });

  it("asks rather than guessing when two of them really do fit", () => {
    const twins = [
      { id: "a", name: "Chicken Wrap" },
      { id: "b", name: "Chicken Burger" },
    ];
    expect(pick("chicken", twins, "Choice")).toBeNull();
    // And a word that is on none of them is not an answer to anything.
    expect(pick("mushroom", WRAPS, "Wrap")).toBeNull();
    expect(pick("erm", WRAPS, "Wrap")).toBeNull();
  });

  it("understands a mangled transcript of a Greek menu", () => {
    // Straight off this line: the transcriber has never been trained on these
    // words, and they are what the shop sells.
    expect(pick("yeeros", WRAPS, "Wrap")).toBe("Gyros Wrap");
    expect(pick("suvlaki", WRAPS, "Wrap")).toBe("Souvlaki Wrap");
    expect(pick("haloumi", SIDES, "Side")).toBe("Halloumi Fries");
  });
});
