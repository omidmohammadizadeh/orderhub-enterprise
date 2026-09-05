import {
  isConfident,
  matchMenuItems,
  scoreItem,
  soundFold,
  splitQuantity,
} from "../voice-menu-match";

// Every mis-hearing in here is from a real call log. The transcriber does not
// know the menu, and asking a language model to pick an exact item id out of
// "Drie coli" leaves it two bad options: guess, or ask again.

const MENU = [
  { name: "Diet Coke" },
  { name: "Coca Cola" },
  { name: "Fanta Orange" },
  { name: "Greek Olives" },
  { name: "Garlic Mayo" },
  { name: "Pepperoni Pizza" },
  { name: "Chicken Burger" },
  { name: "Chicken Wrap" },
  { name: "Garlic Bread" },
];

const best = (said: string) => matchMenuItems(said, MENU)[0]?.item.name;

describe("soundFold", () => {
  it("folds the pairs a phone line loses", () => {
    // Voiced and voiceless get swapped constantly: "three" came back "Drie".
    expect(soundFold("three")).toBe(soundFold("drie"));
    expect(soundFold("cola")).toBe(soundFold("coli"));
    expect(soundFold("pepsi")).toBe(soundFold("bepsi"));
  });

  it("keeps genuinely different words apart", () => {
    // The fold has to be loose enough to help and tight enough to be safe.
    expect(soundFold("coke")).not.toBe(soundFold("cola"));
    expect(soundFold("burger")).not.toBe(soundFold("wrap"));
    expect(soundFold("chicken")).not.toBe(soundFold("kebab"));
  });
});

describe("splitQuantity", () => {
  it("reads a quantity the engine mangled", () => {
    // "Drie coli" — a real transcript of "three cola".
    expect(splitQuantity("Drie coli")).toEqual({ quantity: 3, rest: "coli" });
    expect(splitQuantity("two pepperoni pizza")).toEqual({
      quantity: 2,
      rest: "pepperoni pizza",
    });
    expect(splitQuantity("4 garlic bread")).toEqual({
      quantity: 4,
      rest: "garlic bread",
    });
  });

  it("defaults to one when no number was said", () => {
    expect(splitQuantity("garlic mayo")).toEqual({ quantity: 1, rest: "garlic mayo" });
  });

  it("does not eat the item when the caller said only 'a'", () => {
    expect(splitQuantity("a")).toEqual({ quantity: 1, rest: "a" });
    expect(splitQuantity("a coke").quantity).toBe(1);
    expect(splitQuantity("a coke").rest).toBe("coke");
  });
});

describe("matchMenuItems", () => {
  it("finds the item through a mangled transcript", () => {
    expect(best("coli")).toBe("Coca Cola");
    expect(best("greek olives")).toBe("Greek Olives");
    expect(best("garlic mayo")).toBe("Garlic Mayo");
    expect(best("fanta orange")).toBe("Fanta Orange");
  });

  it("ignores the words around the order", () => {
    // "can I get a large pepperoni pizza please" is one item, not a failure.
    expect(best("can I get a pepperoni pizza please")).toBe("Pepperoni Pizza");
    expect(best("just the garlic bread")).toBe("Garlic Bread");
  });

  it("returns nothing for something not on the menu", () => {
    // Inventing a dish is worse than admitting it isn't sold here.
    expect(matchMenuItems("sushi platter", MENU)).toEqual([]);
    expect(matchMenuItems("", MENU)).toEqual([]);
  });
});

describe("isConfident", () => {
  it("acts on a clear winner", () => {
    expect(isConfident(matchMenuItems("greek olives", MENU))).toBe(true);
  });

  it("refuses to choose between two plausible dishes", () => {
    // "Chicken Burger" and "Chicken Wrap" both match "chicken" — that is a
    // question for the caller, not a coin toss on their behalf.
    const matches = matchMenuItems("chicken", MENU);
    expect(matches.length).toBeGreaterThan(1);
    expect(isConfident(matches)).toBe(false);
  });

  it("is not confident about nothing", () => {
    expect(isConfident([])).toBe(false);
  });
});
