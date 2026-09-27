import { BasketPriceError, buildPricingContext, priceBasket, type BasketLine } from "../checkout-pricing";

// The storefront checkout used to charge whatever unit price the browser sent.
// These pin the re-pricing: honest baskets price exactly as the storefront
// showed them; tampered ones cannot pay less than the menu.

const storefront = (over: Record<string, any> = {}) => ({
  menu: {
    categories: [
      {
        id: "c",
        items: [
          { item: { id: "burger", name: "Burger", basePrice: 8 } },
          { item: { id: "cutlery", name: "Cutlery", basePrice: 0 } },
          {
            item: {
              id: "pizza",
              name: "Margherita",
              basePrice: 9,
              hasMultipleSkus: true,
              productSkus: [
                { name: '10"', plu: "PZ-10", price: 9, modifierGroups: ["toppings"] },
                { name: '12"', plu: "PZ-12", price: 12, modifierGroups: ["toppings"] },
              ],
            },
          },
          { item: { id: "cola", name: "Cola", basePrice: 1.5 } },
        ],
      },
    ],
  },
  brandModifierGroups: [
    {
      id: "extras",
      options: [
        { id: "cheese", name: "Extra cheese", priceAdjustment: 1 },
        { id: "bacon", name: "Bacon", priceAdjustment: 1.5 },
        { id: "onion", name: "Onion", priceAdjustment: 0 },
      ],
    },
    {
      id: "toppings",
      options: [{ id: "ham", name: "Ham", priceAdjustment: 1, pricesBySize: { "10": 1, "12": 1.5 } }],
    },
    // Two options sharing a name at different prices — only a tab without
    // option ids can be ambiguous about which it meant.
    { id: "sauces", options: [{ id: "bbq-free", name: "BBQ", priceAdjustment: 0 }] },
    { id: "premium", options: [{ id: "bbq-dear", name: "BBQ", priceAdjustment: 0.5 }] },
  ],
  itemPromos: {},
  bogo: null,
  freeItem: null,
  ...over,
});

const price = (lines: BasketLine[], over?: Record<string, any>) =>
  priceBasket(buildPricingContext(storefront(over)), lines);

const line = (l: Partial<BasketLine> & { menuItemId: string; unitPrice: number }): BasketLine => ({
  name: l.menuItemId,
  quantity: 1,
  modifiers: [],
  ...l,
});

describe("checkout re-pricing", () => {
  it("prices an honest basket exactly as the storefront did", () => {
    const r = price([
      line({
        menuItemId: "burger",
        unitPrice: 9.5,
        quantity: 2,
        modifiers: [{ name: "Bacon", price: 1.5, optionId: "bacon" }],
      }),
    ]);
    expect(r.lines[0]).toMatchObject({ kind: "PAID", unitPrice: 9.5, exact: true });
    expect(r.subtotal).toBe(19);
  });

  it("refuses a tampered unit price", () => {
    expect(() => price([line({ menuItemId: "burger", unitPrice: 0.01 })])).toThrow(BasketPriceError);
    expect(() => price([line({ menuItemId: "burger", unitPrice: 0.01 })])).toThrow(/price of burger has changed/);
  });

  it("charges the modifier's real price, and its real name, whatever the browser claims", () => {
    // Claims Bacon is free and sends the right-looking total: the server
    // prices Bacon at 1.50 → the line should be 9.50, not 8.00.
    expect(() =>
      price([line({ menuItemId: "burger", unitPrice: 8, modifiers: [{ name: "Bacon", price: 0, optionId: "bacon" }] })]),
    ).toThrow(BasketPriceError);
    // A cheap option's id dressed up with a dear option's name prints as
    // what was actually paid for.
    const r = price([
      line({ menuItemId: "burger", unitPrice: 8, modifiers: [{ name: "Bacon", price: 0, optionId: "onion" }] }),
    ]);
    expect(r.lines[0]!.modifiers[0]).toMatchObject({ name: "Onion", price: 0 });
  });

  it("charges the lower price when the menu price dropped since the tab opened", () => {
    const r = price([line({ menuItemId: "burger", unitPrice: 8.5 })]);
    expect(r.lines[0]!.unitPrice).toBe(8);
  });

  it("prices a size from its plu, with size-specific modifier prices", () => {
    const r = price([
      line({
        menuItemId: "pizza",
        skuPlu: "PZ-12",
        unitPrice: 13.5,
        modifiers: [{ name: "Ham", price: 1.5, optionId: "ham" }],
      }),
    ]);
    expect(r.lines[0]).toMatchObject({ unitPrice: 13.5, exact: true });
    expect(() => price([line({ menuItemId: "pizza", skuPlu: "PZ-12", unitPrice: 9 })])).toThrow(/has changed/);
  });

  it("reads the size from an older tab's line name", () => {
    const r = price([line({ menuItemId: "pizza", name: 'Margherita (12")', unitPrice: 12 })]);
    expect(r.lines[0]).toMatchObject({ unitPrice: 12, exact: true });
  });

  it("with no size to go on, floors at the cheapest size and charges what was shown", () => {
    const r = price([line({ menuItemId: "pizza", name: "Margherita", unitPrice: 12 })]);
    expect(r.lines[0]).toMatchObject({ unitPrice: 12, exact: false });
    expect(() => price([line({ menuItemId: "pizza", name: "Margherita", unitPrice: 8 })])).toThrow(/has changed/);
  });

  it("an ambiguous option name (older tab) is floored at its cheapest meaning", () => {
    const r = price([line({ menuItemId: "burger", unitPrice: 8.5, modifiers: [{ name: "BBQ", price: 0.5 }] })]);
    expect(r.lines[0]).toMatchObject({ unitPrice: 8.5, exact: false });
    const cheap = price([line({ menuItemId: "burger", unitPrice: 8, modifiers: [{ name: "BBQ", price: 0 }] })]);
    expect(cheap.lines[0]!.unitPrice).toBe(8);
  });

  it("refuses something that's no longer on the menu", () => {
    expect(() => price([line({ menuItemId: "ghost", name: "Ghost Burger", unitPrice: 5 })])).toThrow(
      /Ghost Burger is no longer available/,
    );
  });

  it("applies an item promo the way the storefront does", () => {
    const r = price([line({ menuItemId: "burger", unitPrice: 6.4 })], { itemPromos: { burger: { percentageOff: 20 } } });
    expect(r.lines[0]!.unitPrice).toBe(6.4);
  });

  it("lets a genuinely free menu item through", () => {
    expect(price([line({ menuItemId: "cutlery", unitPrice: 0 })]).lines[0]).toMatchObject({ kind: "PAID", unitPrice: 0 });
  });

  it("allows one BOGO freebie per paid line, and no more", () => {
    const over = { bogo: { triggerItemIds: ["burger"] } };
    const ok = price(
      [line({ menuItemId: "burger", unitPrice: 8, quantity: 3 }), line({ menuItemId: "burger", name: "Burger (Free — Buy 1 Get 1)", unitPrice: 0 })],
      over,
    );
    expect(ok.lines.map((l) => l.kind)).toEqual(["PAID", "BOGO"]);
    expect(ok.subtotal).toBe(24);
    expect(() =>
      price(
        [
          line({ menuItemId: "burger", unitPrice: 8 }),
          line({ menuItemId: "burger", unitPrice: 0 }),
          line({ menuItemId: "burger", unitPrice: 0 }),
        ],
        over,
      ),
    ).toThrow(/isn't free any more/);
  });

  it("refuses a £0 line that isn't an offer", () => {
    expect(() => price([line({ menuItemId: "burger", name: "Burger", unitPrice: 0 })])).toThrow(/Burger isn't free any more/);
  });

  it("gives the free gift once the eligible basket clears its minimum", () => {
    const over = { freeItem: { minOrder: 15, freeItemIds: ["cola"], excludedItemIds: ["cutlery"] } };
    const gift = line({ menuItemId: "cola", name: "Cola (Free gift)", unitPrice: 0 });
    expect(price([line({ menuItemId: "burger", unitPrice: 8, quantity: 2 }), gift], over).lines[1]!.kind).toBe("GIFT");
    expect(() => price([line({ menuItemId: "burger", unitPrice: 8 }), gift], over)).toThrow(/isn't free any more/);
    expect(() =>
      price([line({ menuItemId: "burger", unitPrice: 8, quantity: 2 }), gift, { ...gift }], over),
    ).toThrow(/isn't free any more/);
  });

  it("refuses silly quantities", () => {
    expect(() => price([line({ menuItemId: "burger", unitPrice: 8, quantity: 0 })])).toThrow(/whole number/);
    expect(() => price([line({ menuItemId: "burger", unitPrice: 8, quantity: 1.5 })])).toThrow(/whole number/);
  });
});
