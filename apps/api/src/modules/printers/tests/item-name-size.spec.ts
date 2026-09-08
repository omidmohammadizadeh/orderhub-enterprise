// The size has to survive onto the ticket.
//
// Uber Eats order #F7A7D at Best Kebab, 8 Sep. The order card on screen showed
//   Cheese Burger (1/2lb)   Chicken Burger (1/4lb)
// and the printed receipt showed
//   Cheese Burger           Chicken Burger
// A kitchen reading that has no idea which one to make, and the information
// was right there on the screen next to them. Before the burgers it was pizza
// sizes: 'Best Kebab Calzone (12")'.
//
// buildCartItemName packs the modifier list into trailing brackets, and the
// ticket prints those options underneath, so the brackets are stripped to stop
// them printing twice. Marketplace names put the SIZE in that same position.
// The first fix guessed from the text with a list of units and size words —
// which is a vocabulary, and a vocabulary is always missing the next thing a
// shop invents. 1/2lb was the next thing.
//
// The rule now: drop the bracket only when it contains this item's own
// modifier names, which is exactly what buildCartItemName put there.

import { cleanPrintedItemName } from "@orderhub/shared";

const mods = (...names: string[]) => names.map((name) => ({ name }));

describe("what gets printed as the item name", () => {
  it("keeps the size that was lost — order #F7A7D", () => {
    const burger = mods("Lettuce", "Tomatoes", "Ketchup", "Plain Chips");
    expect(cleanPrintedItemName("Cheese Burger (1/2lb)", burger)).toBe(
      "Cheese Burger (1/2lb)",
    );
    expect(cleanPrintedItemName("Chicken Burger (1/4lb)", burger)).toBe(
      "Chicken Burger (1/4lb)",
    );
  });

  it("keeps sizes of every shape, without a vocabulary", () => {
    const m = mods("Chilli Sauce");
    for (const name of [
      'Best Kebab Calzone (12")',
      "Margherita (10 inch)",
      "Coca-Cola (500ml)",
      "Doner Kebab (Large)",
      "Chips (regular)",
      "Parmo (Half Pounder)",
      "Burger (Quarter Pounder)",
      "Shawarma (Wrap or Rice)",
      "Pizza (Familiengröße)",
    ]) {
      expect(cleanPrintedItemName(name, m)).toBe(name);
    }
  });

  it("still drops a modifier list, so nothing prints twice", () => {
    expect(
      cleanPrintedItemName(
        "10 inch Margherita (Classic Crust, Extra Cheese)",
        mods("Classic Crust", "Extra Cheese"),
      ),
    ).toBe("10 inch Margherita");
    expect(
      cleanPrintedItemName("Doner Kebab (Chilli Sauce)", mods("Chilli Sauce")),
    ).toBe("Doner Kebab");
  });

  it("keeps a bracket the item's options don't explain", () => {
    // Half the bracket matching is not enough — that is a name, not a list.
    expect(
      cleanPrintedItemName(
        "Meal Deal (Large, Something Else)",
        mods("Large"),
      ),
    ).toBe("Meal Deal (Large, Something Else)");
  });

  it("keeps brackets on an item with no options at all", () => {
    expect(cleanPrintedItemName("Pepsi (330ml)", [])).toBe("Pepsi (330ml)");
    expect(cleanPrintedItemName("Pepsi (330ml)")).toBe("Pepsi (330ml)");
  });

  it("drops the operator's note either way", () => {
    expect(
      cleanPrintedItemName("Cheese Burger (1/2lb) - Note: no salt", mods("Lettuce")),
    ).toBe("Cheese Burger (1/2lb)");
    expect(
      cleanPrintedItemName("Doner (Chilli Sauce) - Note: extra hot", mods("Chilli Sauce")),
    ).toBe("Doner");
  });

  it("never returns an empty name", () => {
    expect(cleanPrintedItemName("(Chilli Sauce)", mods("Chilli Sauce"))).toBe(
      "(Chilli Sauce)",
    );
  });
});
