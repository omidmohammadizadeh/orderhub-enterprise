import { chargeableInNote } from "../topping-note";

// Call DCjjeFGw, order 5CWRR. The caller corrected himself —
//   "No, I didn't say extra garlic sauce. I said I want extra green pepper
//    and jalapeno on it."
// — and at 17:20:55.618 change_item recorded  note "extra green pepper".
// A note charges nothing and prints as an instruction rather than an option,
// so the shop made a topping it was never paid for.
//
// Two separate faults, both here:
//
//  1. chooseOptions() threw away mergeChoices' report of what it could not
//     place, so change_item answered a failed topping with a cheerful
//     "Changed KEBAB PIZZA: choices …". The model believed it had worked and
//     reached for the note field next.
//  2. Nothing stopped a paid option being written into notes.
//
// Private methods via the prototype — the constructor pulls in Anthropic and
// the orders pipeline, none of which this touches.


const PIZZA = {
  id: "pizza",
  name: "KEBAB PIZZA",
  price: 9.9,
  modifierGroups: [
    {
      id: "toppings",
      name: "Extra Toppings",
      min: 0,
      max: 6,
      options: [
        { id: "jal", name: "+jalapeno", price: 1 },
        { id: "grn", name: "+green pepper", price: 1 },
        { id: "oni", name: "+onions", price: 0 },
      ],
    },
  ],
};

describe("a paid topping is never a note", () => {
  it("refuses the note that lost the money — order 5CWRR", () => {
    expect(chargeableInNote(PIZZA, "extra green pepper")).toBe(
      "+green pepper",
    );
  });

  it("catches the other ways a caller asks for one", () => {
    expect(chargeableInNote(PIZZA, "add green pepper")).toBe("+green pepper");
    expect(chargeableInNote(PIZZA, "extra jalapeno and green pepper")).toBeTruthy();
  });

  it("leaves genuine kitchen instructions alone", () => {
    // Nothing on the menu called "hot" or "crispy" — these are how to cook it.
    expect(chargeableInNote(PIZZA, "extra hot please")).toBeNull();
    expect(chargeableInNote(PIZZA, "well done")).toBeNull();
    expect(chargeableInNote(PIZZA, "cut into squares")).toBeNull();
  });

  it("does not mistake a removal for an order", () => {
    expect(chargeableInNote(PIZZA, "no green pepper")).toBeNull();
    expect(chargeableInNote(PIZZA, "without extra jalapeno")).toBeNull();
    expect(chargeableInNote(PIZZA, "hold the green pepper")).toBeNull();
  });

  it("allows a free option as a note — nobody is under-charged", () => {
    expect(chargeableInNote(PIZZA, "extra onions")).toBeNull();
  });

  it("says nothing when the item has no options at all", () => {
    expect(
      chargeableInNote({ id: "x", name: "Coke", modifierGroups: [] }, "extra green pepper"),
    ).toBeNull();
  });
});

describe("a note that names two toppings", () => {
  it("catches the second one after \"and\" — the exact pair on 5CWRR", () => {
    expect(chargeableInNote(PIZZA, "extra jalapeno and green pepper")).toBeTruthy();
  });

  it("still drops what the caller asked to leave off, and charges the rest", () => {
    expect(chargeableInNote(PIZZA, "no onions and extra green pepper")).toBe(
      "+green pepper",
    );
    expect(chargeableInNote(PIZZA, "extra green pepper and no onions")).toBe(
      "+green pepper",
    );
  });
});
