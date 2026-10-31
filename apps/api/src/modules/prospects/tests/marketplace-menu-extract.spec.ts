import { extractShopFromSavedPage, validateMenuJson } from "@orderhub/shared";

// Fixtures follow the shapes on live Just Eat and Deliveroo pages (30 Oct 2026),
// including the traps: object keys that aren't ids, hidden option-items, and
// image links with placeholders in them.

const page = (nextData: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;

const justEat = () => ({
  props: {
    appProps: {
      preloadedState: {
        menu: {
          restaurant: {
            cdn: {
              truncatedItems: {},
              restaurant: {
                restaurantInfo: {
                  name: "Mama Mia",
                  logoUrl: "https://cdn.example/logo.gif",
                  bannerUrl: "https://res.example/image/upload/{transformations}/v1/uk/restaurants/1",
                  location: { city: "South Shields", postCode: "NE33 2JD" },
                },
                menus: [
                  {
                    categories: [
                      { name: "Pizza", itemIds: ["pizza", "gone"] },
                      { name: "Offers", itemIds: ["deal"] },
                      { name: "Empty", itemIds: [] },
                    ],
                  },
                ],
              },
              items: {
                pizza: {
                  id: "pizza",
                  name: "Margherita",
                  description: "Cheese",
                  imageSources: [
                    { path: "https://res.example/image/upload/c_fill,q_auto,{transformations}/v1/uk/dishes/1" },
                  ],
                  variations: [
                    { id: "p10", name: '10"', basePrice: 9.99, modifierGroupsIds: ["toppings"], dealGroupsIds: null },
                    { id: "p12", name: '12"', basePrice: 11.99, modifierGroupsIds: ["toppings2"], dealGroupsIds: null },
                  ],
                },
                deal: {
                  id: "deal",
                  name: "Meal Deal",
                  imageSources: [],
                  variations: [{ id: "deal", name: "", basePrice: 19.99, modifierGroupsIds: null, dealGroupsIds: ["pick"] }],
                },
                burrito: {
                  id: "burrito",
                  name: "Burrito",
                  imageSources: [],
                  variations: [{ id: "b", name: "", basePrice: 5, modifierGroupsIds: ["salsa"], dealGroupsIds: null }],
                },
              },
              // The keys here are deliberately not the ids.
              modifierGroups: {
                "0": { id: "toppings", name: "Toppings", minChoices: 0, maxChoices: 3, modifiers: ["1", "2"] },
                "1": { id: "toppings2", name: "Toppings", minChoices: 0, maxChoices: 3, modifiers: ["1", "2", "1"] },
                "2": { id: "salsa", name: "Salsa", minChoices: 1, maxChoices: 1, modifiers: ["2"] },
              },
              modifierSets: {
                "0": { id: "1", modifier: { name: "Ham", additionPrice: 1.5 } },
                "1": { id: "2", modifier: { name: "Hot", additionPrice: 0 } },
              },
              dealGroups: {
                "0": {
                  id: "pick",
                  name: "Choose a main",
                  numberOfChoices: 1,
                  dealItemVariations: [
                    { dealItemVariationId: "p10", additionPrice: 0 },
                    { dealItemVariationId: "b", additionPrice: 2 },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
});

const deliveroo = () => ({
  props: {
    initialState: {
      menuPage: {
        menu: {
          metas: {
            root: {
              paginationHasMore: false,
              restaurant: {
                name: "Pepe's",
                currencyCode: "GBP",
                location: { address: { address1: "18 Saint John's Road, London, SW111PN", postCode: null, city: "london" } },
              },
              metatags: { image: "https://roo.example/images/hero/image.jpeg?width=1200" },
              categories: [{ id: "c1", name: "Mains" }],
              items: [
                {
                  id: "i1",
                  categoryId: "c1",
                  name: "Chicken",
                  description: "Grilled",
                  price: { fractional: 899 },
                  image: { url: "https://roo.example/images/a/image.jpeg?width={w}&height={h}" },
                  modifierGroupIds: ["dips"],
                },
                {
                  id: "i2",
                  categoryId: "c1",
                  name: "Pizza",
                  price: { fractional: 800 },
                  modifierGroupIds: ["size", "dips"],
                },
                { id: "hidden", categoryId: "", name: "Option item", price: { fractional: 50 } },
              ],
              modifierGroups: [
                {
                  id: "dips",
                  name: "Dips",
                  minSelection: 0,
                  maxSelection: 2,
                  modifierOptions: [
                    { name: "Mayo", price: { fractional: 50 }, modifierGroupIds: [] },
                    { name: "Spicy", price: { fractional: 0 }, modifierGroupIds: ["heat"] },
                  ],
                },
                {
                  id: "heat",
                  name: "Heat",
                  minSelection: 1,
                  maxSelection: 1,
                  modifierOptions: [{ name: "Hot", price: { fractional: 0 }, modifierGroupIds: ["dips"] }],
                },
                {
                  id: "size",
                  name: "Select size",
                  minSelection: 1,
                  maxSelection: 1,
                  modifierOptions: [
                    { name: "Small", price: { fractional: 0 }, modifierGroupIds: [] },
                    { name: "Large", price: { fractional: 300 }, modifierGroupIds: [] },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  },
});

describe("reading a saved Just Eat page", () => {
  const shop = extractShopFromSavedPage(page(justEat()))!;
  const items = shop.draft.categories.flatMap((c) => c.items);

  it("reads the shop's identity", () => {
    expect(shop.platform).toBe("just_eat");
    expect(shop.shopName).toBe("Mama Mia");
    expect(shop.postcode).toBe("NE33 2JD");
    expect(shop.bannerUrl).toBe("https://res.example/image/upload/v1/uk/restaurants/1");
  });

  it("drops empty categories and items missing from the data", () => {
    expect(shop.draft.categories.map((c) => c.name)).toEqual(["Pizza", "Offers"]);
    expect(shop.draft.categories[0]!.items).toHaveLength(1);
  });

  it("repairs the photo link rather than leaving c_fill,q_auto,v1", () => {
    expect(items[0]!.imageUrl).toBe("https://res.example/image/upload/v1/uk/dishes/1");
  });

  it("turns variations into sizes with pounds as written", () => {
    expect(items[0]!.sizes!.map((s) => [s.name, s.price])).toEqual([['10"', 9.99], ['12"', 11.99]]);
  });

  it("finds options by .id and merges groups repeated under new ids", () => {
    const [ten, twelve] = items[0]!.sizes!;
    expect(ten!.modifierGroupKeys).toEqual(twelve!.modifierGroupKeys);
    const group = shop.draft.modifierGroups.find((g) => g.key === ten!.modifierGroupKeys![0])!;
    expect(group.options).toEqual([
      { name: "Ham", priceAdjustment: 1.5 },
      { name: "Hot", priceAdjustment: 0 },
    ]);
  });

  it("lists a deal's picks, and makes a pick's own choice optional unless every pick has it", () => {
    const deal = items.find((i) => i.name === "Meal Deal")!;
    const groups = deal.modifierGroupKeys!.map((k) => shop.draft.modifierGroups.find((g) => g.key === k)!);
    expect(groups[0]!.options.map((o) => o.name)).toEqual(['Margherita 10"', "Burrito"]);
    expect(groups[0]!.options[1]!.priceAdjustment).toBe(2);
    expect(groups.find((g) => g.name === "Salsa")!.minSelections).toBe(0);
  });

  it("produces a draft the JSON menu import accepts", () => {
    expect(validateMenuJson(shop.draft).errors).toEqual([]);
  });
});

describe("reading a saved Deliveroo page", () => {
  const shop = extractShopFromSavedPage(page(deliveroo()))!;
  const items = shop.draft.categories.flatMap((c) => c.items);

  it("reads the shop's identity", () => {
    expect(shop.platform).toBe("deliveroo");
    expect(shop.postcode).toBe("SW111PN");
    expect(shop.city).toBe("London");
    expect(shop.bannerUrl).toBe("https://roo.example/images/hero/image.jpeg");
  });

  it("skips the hidden option-items and converts pence", () => {
    expect(items.map((i) => i.name)).toEqual(["Chicken", "Pizza"]);
    expect(items[0]!.price).toBe(8.99);
  });

  it("uses the bare photo link", () => {
    expect(items[0]!.imageUrl).toBe("https://roo.example/images/a/image.jpeg");
  });

  it("turns a size group into sizes that also carry the item's groups", () => {
    const pizza = items[1]!;
    expect(pizza.sizes!.map((s) => [s.name, s.price])).toEqual([["Small", 8], ["Large", 11]]);
    expect(pizza.sizes![0]!.modifierGroupKeys).toEqual(items[0]!.modifierGroupKeys);
  });

  it("flattens a nested group as optional, and survives a loop between groups", () => {
    const groups = items[0]!.modifierGroupKeys!.map((k) => shop.draft.modifierGroups.find((g) => g.key === k)!);
    expect(groups.map((g) => g.name)).toEqual(["Dips", "Heat"]);
    expect(groups[1]!.minSelections).toBe(0);
  });

  it("warns when the page only held part of the menu", () => {
    const partial = deliveroo();
    partial.props.initialState.menuPage.menu.metas.root.paginationHasMore = true;
    expect(extractShopFromSavedPage(page(partial))!.draft.warnings).toHaveLength(1);
  });

  it("produces a draft the JSON menu import accepts", () => {
    expect(validateMenuJson(shop.draft).errors).toEqual([]);
  });
});

describe("saved pages it can't read", () => {
  it("returns null for pages with no embedded menu, so they go to the AI reader", () => {
    expect(extractShopFromSavedPage("<html><body>Uber Eats</body></html>")).toBeNull();
    expect(extractShopFromSavedPage(page({ props: {} }))).toBeNull();
    expect(extractShopFromSavedPage('<script id="__NEXT_DATA__">{broken</script>')).toBeNull();
  });

  it("reads Chrome's single-file save, including a multi-byte character", () => {
    const data = justEat();
    data.props.appProps.preloadedState.menu.restaurant.cdn.restaurant.restaurantInfo.name = "Café";
    const html = page(data);
    const encoded = html
      .replace(/=/g, "=3D")
      .replace(/é/g, "=C3=A9")
      .replace(/(.{70})/g, "$1=\r\n");
    const mhtml = `Content-Transfer-Encoding: quoted-printable\r\n\r\n${encoded}`;
    expect(extractShopFromSavedPage(mhtml)!.shopName).toBe("Café");
  });
});
