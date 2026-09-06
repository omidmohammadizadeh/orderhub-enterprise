// Telling the transcriber what this shop sells before it listens.

import { keytermsFromMenu } from "../voice-keyterms";

const GREEK = [
  { id: "1", name: "Chicken Gyros Wrap" },
  { id: "2", name: "Lamb Gyros Wrap" },
  { id: "3", name: "Souvlaki Skewers" },
  { id: "4", name: "Halloumi Fries" },
  {
    id: "5",
    name: "Mixed Grill",
    modifierGroups: [
      { options: [{ name: "Tzatziki" }, { name: "Chilli Sauce" }, { name: "Garlic Sauce" }] },
    ],
  },
  { id: "6", name: 'Margherita Pizza (12")' },
  { id: "7", name: "Coca-Cola 330ml" },
];

describe("what the transcriber is told to listen for", () => {
  const terms = keytermsFromMenu(GREEK);

  it("boosts the words a transcriber has never been trained on", () => {
    // These are the words a Greek takeaway is built on, and the ones that came
    // back as "heroes", "civlaki" and "coffee" on real calls.
    expect(terms).toContain("gyros");
    expect(terms).toContain("souvlaki");
    expect(terms).toContain("halloumi");
    expect(terms).toContain("tzatziki");
    expect(terms).toContain("margherita");
  });

  it("does not waste the budget on words English already knows", () => {
    // 100 slots, and every one spent on "chicken" is one not spent on
    // "souvlaki". Nova-3 has never struggled with "chicken".
    for (const ordinary of ["chicken", "wrap", "fries", "sauce", "pizza", "cheese", "the"]) {
      expect(terms).not.toContain(ordinary);
    }
  });

  it("leaves out numbers and sizes", () => {
    expect(terms.some((t) => /\d/.test(t))).toBe(false);
    expect(terms).not.toContain("inch");
  });

  it("puts the shop's own commonest words first", () => {
    // A shop whose every item is a gyros should spend its budget saying so.
    expect(terms[0]).toBe("gyros");
  });

  it("never asks for more than the transcriber accepts", () => {
    const huge = Array.from({ length: 500 }, (_, i) => ({ name: `Zzdish${i} Speciality` }));
    expect(keytermsFromMenu(huge).length).toBeLessThanOrEqual(100);
    expect(keytermsFromMenu(GREEK, 3)).toHaveLength(3);
  });

  it("copes with a menu that is empty or malformed", () => {
    expect(keytermsFromMenu([])).toEqual([]);
    expect(keytermsFromMenu([{}, { name: undefined }] as any)).toEqual([]);
    expect(keytermsFromMenu([{ name: "Gyros", modifierGroups: [{}] }] as any)).toEqual(["gyros"]);
  });
});
