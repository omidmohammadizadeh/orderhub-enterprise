import { HubRiseAdapter } from "../adapters/hubrise.adapter";

// Pizza sizes never reached the kitchen.
//
// HubRise sends a sized product as product_name + sku_name — "Margherita" and
// "12 inch". The adapter used sku_name only as a fallback for a missing
// product_name, so on every sized item the size was thrown away: the board and
// the printed ticket both said "Margherita" with no indication of which one to
// make.

const adapter = new HubRiseAdapter();

function orderWith(items: any[]) {
  return {
    id: "sized1",
    ref: "1",
    status: "new",
    service_type: "delivery",
    channel: "Uber Eats",
    connection_name: "BEST KEBAB",
    created_at: new Date().toISOString(),
    customer: { first_name: "A", last_name: "B" },
    items,
    total: "10.00 GBP",
  };
}

const item = (over: Record<string, any>) => ({
  sku_ref: "x",
  quantity: "1.0",
  price: "10.00 GBP",
  subtotal: "10.00 GBP",
  ...over,
});

const names = (order: any) =>
  ((adapter.normalize(order, "loc-1") as any).items ?? []).map(
    (i: any) => i.name,
  );

describe("HubRise item sizes", () => {
  it("puts the variant on the item name", () => {
    expect(
      names(
        orderWith([item({ product_name: "Margherita", sku_name: "12 inch" })]),
      ),
    ).toEqual(["Margherita (12 inch)"]);
  });

  it("leaves an unsized product alone when both names match", () => {
    expect(
      names(
        orderWith([
          item({ product_name: "Garlic Bread", sku_name: "Garlic Bread" }),
        ]),
      ),
    ).toEqual(["Garlic Bread"]);
  });

  it("doesn't say the size twice when the product name already has it", () => {
    expect(
      names(
        orderWith([
          item({ product_name: "12 inch Margherita", sku_name: "12 inch" }),
        ]),
      ),
    ).toEqual(["12 inch Margherita"]);
  });

  it("still falls back to the variant when there is no product name", () => {
    expect(names(orderWith([item({ sku_name: "Large" })]))).toEqual(["Large"]);
  });

  it("handles an item with neither", () => {
    expect(names(orderWith([item({})]))).toEqual(["Item"]);
  });
});
