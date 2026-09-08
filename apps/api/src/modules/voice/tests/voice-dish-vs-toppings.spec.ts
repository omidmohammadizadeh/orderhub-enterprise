import {
  matchItemGroups,
  isConfidentGroup,
  dishPhrase,
} from "../voice-menu-match";

// Call TiqIEZ-A, amending order 5CWRR. The caller asked for
//   "a 12-inch margarita with extra jalapeno and green pepper"
// and then answered "Margarita" three more times. Every add_item came back
// with the same three names and the bot ended on "for the last time, which
// pizza is it".
//
// The matcher was never the problem — "margarita" alone resolves MARGHERITHA
// at 1.00. The TOPPINGS were: "green pepper" scores PEPPERONI a dead heat
// against the pizza the caller actually named, so neither could win.

const PIZZAS = [
  { name: "PEPPERONI", categoryName: "PIZZA" },
  { name: "MARGHERITHA", categoryName: "PIZZA" },
  { name: "GRAN DUCA", categoryName: "PIZZA" },
  { name: "KEBAB PIZZA", categoryName: "PIZZA" },
];

const best = (said: string, items = PIZZAS) => {
  const m = matchItemGroups(said, items as any, { limit: 3 });
  return { confident: isConfidentGroup(m), top: m[0]?.group.base, all: m };
};

describe("the dish is not decided by its toppings", () => {
  it("the spoken sentence that started the loop", () => {
    const whole = best("12-inch margarita with extra jalapeno and green pepper");
    // Reproduces the bug: PEPPERONI ties with MARGHERITHA on "pepper".
    expect(whole.confident).toBe(false);

    // …and the dish half alone is decisive.
    const dish = best(dishPhrase("12-inch margarita with extra jalapeno and green pepper"));
    expect(dish.confident).toBe(true);
    expect(dish.top).toBe("MARGHERITHA");
  });

  it("cuts the sentence at the extras, keeping size", () => {
    expect(dishPhrase("12-inch margarita with extra jalapeno and green pepper")).toBe(
      "12-inch margarita",
    );
    expect(dishPhrase("large pepperoni no onions")).toBe("large pepperoni");
    expect(dishPhrase("kebab pizza add jalapeno")).toBe("kebab pizza");
  });

  it("leaves a dish whose NAME contains 'with' alone", () => {
    // A real item on this tenant. Cutting at "with" would have broken it.
    const said = "portion of chicken shawarma with chips, salad & sauce";
    expect(dishPhrase(said)).toBe(said);
  });

  it("leaves an ordinary order untouched", () => {
    expect(dishPhrase("two pepperoni")).toBe("two pepperoni");
    expect(dishPhrase("margarita")).toBe("margarita");
  });

  it("still resolves the spellings a caller actually says", () => {
    for (const said of ["margarita", "margherita", "margheritha"]) {
      const r = best(said);
      expect(r.confident).toBe(true);
      expect(r.top).toBe("MARGHERITHA");
    }
  });

  it("a genuinely ambiguous dish still asks", () => {
    // Nothing here separates them, and it should ask rather than guess.
    const two = [
      { name: "CHICKEN BURGER", categoryName: "BURGERS" },
      { name: "CHICKEN WRAP", categoryName: "WRAPS" },
    ];
    expect(best("chicken", two).confident).toBe(false);
  });
});
