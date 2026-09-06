// The size has to survive onto the ticket.
//
// From a live Uber Eats order: the order card on screen showed
//   Best Kebab Calzone (12")
// and the printed receipt showed
//   Best Kebab Calzone
// A kitchen reading that has no idea which of three sizes to make, and the
// information was right there on the screen next to them.
//
// The cause is a rule that is correct for our own names and wrong for
// everybody else's. buildCartItemName puts the size in FRONT and the modifier
// list in trailing brackets — "10 inch Margherita (Classic Crust, Extra
// Cheese)" — and the modifiers are printed on their own lines underneath, so
// the brackets are dropped to stop them printing twice. HubRise writes it the
// other way round, and the size went in the bin with them.

import { PrintRoutingService } from "../print-routing.service";

const clean = (name: string): string =>
  (PrintRoutingService.prototype as any).cleanItemName.call(
    PrintRoutingService.prototype,
    name,
  );

describe("what gets printed as the item name", () => {
  it("keeps a size written in brackets", () => {
    expect(clean('Best Kebab Calzone (12")')).toBe('Best Kebab Calzone (12")');
    expect(clean("Margherita (10 inch)")).toBe("Margherita (10 inch)");
    expect(clean("Coca-Cola (500ml)")).toBe("Coca-Cola (500ml)");
    expect(clean("Doner Kebab (Large)")).toBe("Doner Kebab (Large)");
    expect(clean("Chips (regular)")).toBe("Chips (regular)");
  });

  it("still drops a modifier list", () => {
    // These are printed underneath as their own lines. Leaving them in the
    // name prints the whole lot twice on a 58mm roll.
    expect(clean("10 inch Margherita (Classic Crust, Extra Cheese)")).toBe(
      "10 inch Margherita",
    );
    expect(clean("Doner Kebab (Chilli Sauce)")).toBe("Doner Kebab");
    expect(clean("Wrap (Peri Peri Sauce)")).toBe("Wrap");
  });

  it("drops a single-word modifier that is not a size", () => {
    expect(clean("Burger (Cheese)")).toBe("Burger");
    expect(clean("Pizza (Mushrooms)")).toBe("Pizza");
  });

  it("treats anything with a comma as a list, however it reads", () => {
    // "(Large, Extra Cheese)" is a list that happens to start with a size.
    // Keeping it would print the cheese twice, and the size is only half the
    // reason it is there.
    expect(clean("Pizza (Large, Extra Cheese)")).toBe("Pizza");
  });

  it("cuts a note off the end, size or not", () => {
    expect(clean('Best Kebab Calzone (12") - Note: no chilli')).toBe(
      'Best Kebab Calzone (12")',
    );
    expect(clean("Margherita (Extra Cheese) - Note: well done")).toBe("Margherita");
  });

  it("leaves an ordinary name alone", () => {
    expect(clean("Cheesy Garlic Mushrooms")).toBe("Cheesy Garlic Mushrooms");
    expect(clean("")).toBe("");
    expect(clean(null as any)).toBe("");
  });
});
