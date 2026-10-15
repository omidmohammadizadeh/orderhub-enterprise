import { describe, expect, it } from "vitest";
import { supplierListsForMenus } from "./supplier-lists";

const slugs = (names: string[]) => supplierListsForMenus(names).map((l) => l.slug);

describe("supplierListsForMenus", () => {
  it("offers only the brands a location has a menu for", () => {
    expect(
      slugs(["Korean Fried Chicken — WANSTEAD", "MONSTER BURGERZ-WANSTEAD", "FIESTA MEXA-WANSTEAD", "GREEK GYROS-WANSTEAD"]),
    ).toEqual(["monster-burgerz", "greek-gyros", "korean-fried-chicken", "fiesta-mexica"]);
  });

  it("tells twin brands apart and reads the real menu spellings", () => {
    expect(slugs(["BURGER AND FRIEZ-AYLESBURY", "GREEK BITE-CLIFTON"])).toEqual(["burgerz-and-friez", "greek-bite"]);
    expect(slugs(["KFC Gateshead Felling", "Chicago Pizzeria-Aylesbury"])).toEqual(["korean-fried-chicken", "chicago-pizzeria"]);
  });

  it("shows nothing for a shop with none of our brands", () => {
    expect(slugs(["Cafe Breakfast", "Wanna Smash?"])).toEqual([]);
  });
});
