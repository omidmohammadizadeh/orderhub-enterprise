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
  // The operator ran both versions on live calls. Conversational is faster on
  // paper and this is the one orders actually got through on, so this is the
  // one that ships — a choice that cannot be misheard beats a choice that is
  // three seconds quicker when it works.
  it("reads the numbers out", () => {
    const { say } = ordering();
    expect(say).toContain(
      "For your wrap, press 1 for Gyros Wrap, 2 for Halloumi Wrap, 3 for Souvlaki Wrap.",
    );
  });

  it("walks them through one question at a time", () => {
    const { s, c, st } = ordering();
    const second = s.answerItemOption(c, st, "gyros");
    expect(second).toContain(
      "For your side, press 1 for Oregano Fries, 2 for Olives, 3 for Halloumi Fries.",
    );
    const third = s.answerItemOption(c, st, "olives");
    expect(third).toContain("For your drink, press 1 for Coke, 2 for Diet Coke.");
  });

  it("stops reading numbers when there are too many to hold in your head", () => {
    // Nine numbered sauces is not a choice, it is a memory test. Past five,
    // saying it is genuinely the better way and the caller is told so.
    const s = svc();
    const c = ctx();
    const many = {
      id: "big",
      name: "Mixed Grill",
      price: 15,
      modifierGroups: [
        {
          id: "sauce",
          name: "Sauce",
          required: true,
          min: 1,
          options: Array.from({ length: 8 }, (_, i) => ({
            id: `s${i}`,
            name: `Sauce ${i + 1}`,
            price: 0,
          })),
        },
      ],
    };
    c.itemIndex.set("big", many);
    const st: any = { cart: { items: [] }, turns: [] };
    st.pendingItem = { itemId: "big", quantity: 1, chosen: [] };
    const ask = s.askNextOption(c, st);

    expect(ask.say).toContain("5 for Sauce 5");
    expect(ask.say).not.toContain("6 for");
    expect(ask.say).toContain("Or just say what you'd like.");
    expect(st.choices).toHaveLength(5);
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
    expect(say).toMatch(/For your side/);
    expect(st.choices).toEqual(["f1", "f2", "f3"]);
  });

  it("carries a whole meal through on the keypad alone", () => {
    const { s, c, st } = ordering();
    s.chooseByNumber(c, st, "1"); // Gyros Wrap
    s.chooseByNumber(c, st, "1"); // Oregano Fries
    const note = s.chooseByNumber(c, st, "2"); // Diet Coke
    expect(note).toMatch(/Any notes for the solo meal/i);
    const done = s.answerItemNote(c, st, "no");

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
    s.answerItemNote(c, st, "no");

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
    expect(ask.say).toContain(
      "For your side, press 1 for Oregano Fries, 2 for Olives, 3 for Halloumi Fries.",
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
    expect(back.pendingItem.misses).toBe(0);
    expect(back.pendingItem.walked).toBe(true);
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

describe("the note the kitchen needs", () => {
  // What a customer says across the counter and has never had a way to say to
  // a phone: no onions, extra crispy, cut it in half. Asked once per dish they
  // were walked through, and skippable with one key by everyone else.

  const walked = () => {
    const o = ordering();
    o.s.chooseByNumber(o.c, o.st, "1");
    o.s.chooseByNumber(o.c, o.st, "1");
    const say = o.s.chooseByNumber(o.c, o.st, "1");
    return { ...o, say };
  };

  it("is offered once every choice is made", () => {
    const { say, st } = walked();
    // Named back first: somebody who pressed 1 has no idea whether it
    // registered, or what it registered AS. They pressed a key into silence
    // and got a different question.
    expect(say).toBe(
      "Coke. Any notes for the solo meal — anything like no onions or extra sauce? Say it now, or press 1 if not.",
    );
    expect(st.pendingItem).toBeTruthy();
    expect(st.cart.items).toHaveLength(0);
    // Nothing is numbered here, so a stray keypress cannot pick a modifier.
    expect(st.choices).toBeUndefined();
  });

  it("puts what they said on that line and nowhere else", () => {
    const { s, c, st } = walked();
    const done = s.answerItemNote(c, st, "no onions and extra chilli sauce");

    expect(st.cart.items[0].notes).toBe("no onions and extra chilli sauce");
    expect(done).toMatch(/Solo Meal/);
    // It is a note, not an order: nothing about "extra chilli sauce" may turn
    // into a second line or a modifier the caller never chose.
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items[0].modifiers).toHaveLength(3);
  });

  it("takes no for an answer, however they say it", () => {
    for (const said of ["no", "no thanks", "nope", "nothing", "no that's it"]) {
      const { s, c, st } = walked();
      expect(s.answerItemNote(c, st, said)).toMatch(/Solo Meal/);
      expect(st.cart.items[0].notes).toBeUndefined();
    }
  });

  it("asks what the note is when they only agreed to give one", () => {
    // "Yes" is somebody accepting the offer, not the note itself. Writing it
    // on the ticket would put the word "yes" in front of a chef.
    const { s, c, st } = walked();
    expect(s.answerItemNote(c, st, "yes")).toMatch(/what would you like me to put on it/i);
    expect(st.cart.items).toHaveLength(0);

    const done = s.answerItemNote(c, st, "yes, no onions please");
    expect(st.cart.items[0].notes).toBe("no onions please");
    expect(done).toMatch(/Solo Meal/);
  });

  it("is not asked of someone who was never asked anything", () => {
    // "A garlic bread" has no choices to make. A note question after every
    // single line is a step per item for no reason.
    const s = svc();
    const c = ctx();
    const st: any = { cart: { items: [] }, turns: [] };
    const out = s.quickAddAloud(c, st, "a garlic bread");

    expect(out.say).not.toMatch(/notes/i);
    expect(st.cart.items).toHaveLength(1);
  });
});

it("does not mistake the commonest note there is for a refusal", () => {
  // "No onions" begins with "no". Matching on the first word threw away the
  // one instruction the kitchen needed and told the caller it was on there.
  const o = ordering();
  o.s.chooseByNumber(o.c, o.st, "1");
  o.s.chooseByNumber(o.c, o.st, "1");
  o.s.chooseByNumber(o.c, o.st, "1");
  o.s.answerItemNote(o.c, o.st, "no onions");

  expect(o.st.cart.items[0].notes).toBe("no onions");
});

describe("how a menu says a choice is compulsory", () => {
  const { mustChoose, needed } = require("../voice-menu-match");

  it("believes minSelections, not just the flag", () => {
    // From the live menu, and the reason a pizzeria's crust was never asked
    // about: the till reads the minimum and asks, this line read the flag and
    // said nothing, so every pizza reached the kitchen with no crust on it
    // while the operator watched POS get it right.
    expect(mustChoose({ required: false, min: 1 })).toBe(true); // select your pizza crust
    expect(mustChoose({ required: false, min: 2 })).toBe(true); // SELECT YOUR SAUCES
    expect(mustChoose({ required: true, min: 0 })).toBe(true);
    expect(mustChoose({ required: false, min: 0 })).toBe(false); // select your extra toppings
    expect(mustChoose({})).toBe(false);
  });

  it("asks for as many as the menu says", () => {
    expect(needed({ min: 2 })).toBe(2);
    expect(needed({ required: true, min: 0 })).toBe(1);
    expect(needed({ required: true })).toBe(1);
  });

  it("walks a caller through a group the menu only marks with a minimum", () => {
    const s = svc();
    const c = ctx();
    const pizza = {
      id: "pep",
      name: "PEPPERONI",
      price: 7.8,
      modifierGroups: [
        {
          id: "crust",
          name: "select your pizza crust",
          // Exactly as it comes out of the real menu.
          required: false,
          min: 1,
          options: [
            { id: "c1", name: "Classic", price: 0 },
            { id: "c2", name: "Thin", price: 0 },
            { id: "c3", name: "Stuffed", price: 1.5 },
          ],
        },
      ],
    };
    c.itemIndex.set("pep", pizza);
    c.items.push(pizza);

    const st: any = { cart: { items: [] }, turns: [] };
    st.pendingItem = { itemId: "pep", quantity: 1, chosen: [] };
    const ask = s.askNextOption(c, st);

    expect(ask.say).toContain(
      "For your select your pizza crust, press 1 for Classic, 2 for Thin, 3 for Stuffed.",
    );
    expect(st.choices).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps asking until a two-choice group has two", () => {
    const s = svc();
    const c = ctx();
    const dish = {
      id: "mix",
      name: "MIXED GRILL",
      price: 15,
      modifierGroups: [
        {
          id: "sauces",
          name: "SELECT YOUR SAUCES",
          required: false,
          min: 2,
          options: [
            { id: "s1", name: "Garlic", price: 0 },
            { id: "s2", name: "Chilli", price: 0 },
            { id: "s3", name: "BBQ", price: 0 },
          ],
        },
      ],
    };
    c.itemIndex.set("mix", dish);
    c.items.push(dish);

    const st: any = { cart: { items: [] }, turns: [] };
    st.pendingItem = { itemId: "mix", quantity: 1, chosen: [] };
    // Said in lower case, because a menu shouting at a caller reads as a
    // machine: "For your select your sauces, press 1 for Garlic…"
    expect(s.askNextOption(c, st).say).toContain("select your sauces");
    // One picked is not enough.
    st.pendingItem.chosen = ["s1"];
    expect(s.askNextOption(c, st)).not.toBeNull();
    st.pendingItem.chosen = ["s1", "s2"];
    expect(s.askNextOption(c, st)).toBeNull();
  });

  it("leaves a genuinely optional group alone", () => {
    // "select your extra toppings", min 0. Nobody should be interrogated about
    // extras before their food can be made.
    const s = svc();
    const c = ctx();
    const dish = {
      id: "plain",
      name: "PLAIN PIZZA",
      price: 7,
      modifierGroups: [
        {
          id: "extras",
          name: "select your extra toppings",
          required: false,
          min: 0,
          options: [{ id: "e1", name: "Extra Cheese", price: 1 }],
        },
      ],
    };
    c.itemIndex.set("plain", dish);
    const st: any = { cart: { items: [] }, turns: [] };
    st.pendingItem = { itemId: "plain", quantity: 1, chosen: [] };
    expect(s.askNextOption(c, st)).toBeNull();
  });
});
