import { buildKitchenTicketPayload } from "../formatters/kitchen-ticket.formatter";

const order = {
  id: "o1",
  displayId: "12",
  platform: "POS",
  orderSource: "POS",
  fulfillmentType: "COLLECTION",
  customerInfo: { name: "Sam" },
  paymentMethod: "CASH",
  paymentStatus: "PAID",
  items: [
    { menuItemId: "mi1", name: "Salt & Pepper Chicken", quantity: 2, modifiers: [] },
    { menuItemId: "mi2", name: "Egg Fried Rice", quantity: 1, modifiers: [] },
    { menuItemId: null, name: "Custom item", quantity: 1, modifiers: [] },
  ],
};

describe("kitchen ticket — second language", () => {
  it("carries the kitchen name for products that have one", () => {
    const p = buildKitchenTicketPayload(order, 1, new Map([["mi1", "椒盐鸡"]]));
    expect(p.items[0]!.secondLanguageName).toBe("椒盐鸡");
  });

  it("leaves an untranslated product null so it keeps printing English", () => {
    // A shop translates its menu a few items at a time; the rest must not
    // break in the meantime.
    const p = buildKitchenTicketPayload(order, 1, new Map([["mi1", "椒盐鸡"]]));
    expect(p.items[1]!.secondLanguageName).toBeNull();
    expect(p.items[1]!.name).toBe("Egg Fried Rice");
  });

  it("handles an order line with no menu item behind it", () => {
    // POS custom lines have no menuItemId to look up.
    const p = buildKitchenTicketPayload(order, 1, new Map([["mi1", "椒盐鸡"]]));
    expect(p.items[2]!.secondLanguageName).toBeNull();
  });

  it("is null everywhere when no map is passed — the default for every shop", () => {
    const p = buildKitchenTicketPayload(order, 1);
    for (const i of p.items) expect(i.secondLanguageName).toBeNull();
  });

  it("never replaces the English name, only adds alongside it", () => {
    // The renderer decides which to print; the payload keeps both so a
    // ticket is never left without a name at all.
    const p = buildKitchenTicketPayload(order, 1, new Map([["mi1", "椒盐鸡"]]));
    expect(p.items[0]!.name).toBe("Salt & Pepper Chicken");
  });
});
