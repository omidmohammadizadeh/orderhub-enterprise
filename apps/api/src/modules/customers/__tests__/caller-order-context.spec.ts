import { CustomersService } from "../customers.service";

// What the caller popup shows BESIDES the name: the order already in the
// kitchen, and the one worth having again.
//
// The two are not interchangeable. Someone with food being made is ringing
// about that order, and offering them a repeat instead is how a second dinner
// gets cooked — so these tests pin which one wins, and when.

const HISTORY = {
  customerName: "Omid",
  customerPhone: "+44 7788 180709",
  customerInfo: {},
  deliveryAddress: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postcode: null,
  createdAt: new Date("2026-06-01"),
  total: 24.5,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

function orderRow(over: Record<string, any> = {}) {
  return {
    id: "o1",
    displayId: null,
    orderNumber: 41,
    status: "PREPARING",
    total: 24.5,
    createdAt: hoursAgo(1),
    customerPhone: "+447788180709",
    fulfillmentType: "DELIVERY",
    location: { currency: "GBP" },
    items: [
      { name: "Margherita", quantity: 2 },
      { name: "Garlic Bread", quantity: 1 },
    ],
    ...over,
  };
}

/** First findMany answers the year-wide history scan, second the shop scan. */
function setup(shopOrders: any[], history: any[] = [HISTORY]) {
  const findMany = jest
    .fn()
    .mockResolvedValueOnce(history)
    .mockResolvedValueOnce(shopOrders);
  return {
    svc: new CustomersService({ order: { findMany } } as any),
    findMany,
  };
}

describe("the order attached to a ringing caller", () => {
  it("shows an unfinished order placed today as the live one", async () => {
    const { svc } = setup([orderRow()]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.openOrder).toMatchObject({
      id: "o1",
      reference: "41",
      status: "PREPARING",
      itemCount: 3,
      summary: "2× Margherita, Garlic Bread",
    });
    // Nothing to repeat: the only order is the live one, and it must not
    // appear twice under two different headings.
    expect(hit!.lastOrder).toBeNull();
  });

  it("does NOT treat yesterday's unfinished order as live", async () => {
    // A customer ringing at opening time about last night's late delivery is
    // asking about a closed matter; showing it as live sends staff chasing a
    // driver who went home.
    //
    // The clock is pinned because "yesterday" is the whole assertion: with a
    // real clock this passes all evening and fails every morning, when 20
    // hours ago is still today.
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    jest.setSystemTime(new Date("2026-06-02T10:00:00Z"));
    try {
      const { svc } = setup([
        orderRow({ createdAt: new Date("2026-06-01T22:00:00Z"), status: "PREPARING" }),
      ]);
      const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
      expect(hit!.openOrder).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("offers the last COMPLETED order to repeat when nothing is live", async () => {
    const { svc } = setup([
      orderRow({ id: "o9", status: "COMPLETED", createdAt: hoursAgo(72), orderNumber: 38 }),
    ]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.openOrder).toBeNull();
    expect(hit!.lastOrder).toMatchObject({ id: "o9", reference: "38" });
  });

  it("never puts the same order in both slots", async () => {
    // Placed and completed within the hour — one order, not two.
    const { svc } = setup([orderRow({ status: "COMPLETED" })]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.openOrder).toBeNull();
    expect(hit!.lastOrder!.id).toBe("o1");
  });

  it("skips a cancelled order entirely — it is neither live nor repeatable", async () => {
    const { svc } = setup([orderRow({ status: "CANCELLED" })]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.openOrder).toBeNull();
    expect(hit!.lastOrder).toBeNull();
  });

  it("won't repeat an order with no items", async () => {
    const { svc } = setup([orderRow({ status: "COMPLETED", items: [] })]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.lastOrder).toBeNull();
  });

  it("asks only for orders this shop can act on, at this shop, recently", async () => {
    const { svc, findMany } = setup([orderRow()]);
    await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    const where = findMany.mock.calls[1][0].where;
    expect(where).toMatchObject({ tenantId: "t1", locationId: "loc-1", isSandbox: false });
    // A marketplace order belongs to the marketplace: we cannot amend it and
    // its items are priced on somebody else's menu.
    expect(where.orderSource.in).toEqual(["VOICE", "POS", "ONLINE", "DIRECT"]);
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("re-checks the phone itself — `contains` is only a pre-filter", async () => {
    // The real case this guards, and it has happened: a sender that repeats
    // the number and truncates it stores 079400539720794 for a caller on
    // 07940053972. That string CONTAINS the caller's suffix, so the database
    // hands it over — but it does not END with it, and it is not their order.
    const { svc } = setup(
      [orderRow({ customerPhone: "079400539720794" })],
      [{ ...HISTORY, customerPhone: "07940053972" }],
    );
    const hit = await svc.lookupByPhone("t1", "07940053972", { locationId: "loc-1" });
    expect(hit).not.toBeNull();
    expect(hit!.openOrder).toBeNull();
  });

  it("attaches no order at all when the ringing shop isn't known", async () => {
    const findMany = jest.fn().mockResolvedValueOnce([HISTORY]);
    const svc = new CustomersService({ order: { findMany } } as any);
    const hit = await svc.lookupByPhone("t1", "07788180709");
    expect(hit!.openOrder).toBeNull();
    expect(hit!.lastOrder).toBeNull();
    // One query, not two — nothing to scope a second one to.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("still shows the caller when the order lookup blows up", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([HISTORY])
      .mockRejectedValueOnce(new Error("db went away"));
    const svc = new CustomersService({ order: { findMany } } as any);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    // The name is the part staff actually need while the phone is ringing.
    expect(hit!.name).toBe("Omid");
    expect(hit!.openOrder).toBeNull();
  });
});

describe("what the customer is worth", () => {
  it("adds up the window's orders and dates them", async () => {
    const { svc } = setup(
      [],
      [
        { ...HISTORY, total: 24.5, createdAt: new Date("2026-06-01") },
        { ...HISTORY, total: 10.25, createdAt: new Date("2026-01-15") },
      ],
    );
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.lifetimeSpend).toBe(34.75);
    expect(hit!.firstOrderAt).toBe(new Date("2026-01-15").toISOString());
    expect(hit!.lastOrderAt).toBe(new Date("2026-06-01").toISOString());
  });

  it("reports no spend rather than £0 when the orders carried no totals", async () => {
    const { svc } = setup([], [{ ...HISTORY, total: null }]);
    const hit = await svc.lookupByPhone("t1", "07788180709", { locationId: "loc-1" });
    expect(hit!.lifetimeSpend).toBeNull();
  });
});
