import { OrdersService, GUEST_PREPAY_UNPAID } from "../orders.service";

// A guest paying at the table (Table Tabs, PAY_NOW) has their order written
// BEFORE the card is charged — the PaymentIntent needs an order to belong to.
// It used to sit on the board as "Waiting for payment" and stay there forever
// when the guest closed the sheet or the card was declined. Online card orders
// never showed until paid; the table now behaves the same way.

function makeService(hiddenIds: string[]) {
  const calls: any[] = [];
  const prisma: any = {
    userLocation: { findMany: jest.fn(async () => [{ locationId: "l1" }]) },
    userBrand: { findMany: jest.fn(async () => []) },
    brand: { findMany: jest.fn(async () => []) },
    location: { findUnique: jest.fn(async () => ({ timezone: "Europe/London" })) },
    order: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async (args: any) => {
        calls.push(args);
        // The id lookup selects only ids; answer it with the hidden set.
        if (args?.select?.id && Object.keys(args.select).length === 1) {
          return hiddenIds.map((id) => ({ id }));
        }
        return [];
      }),
    },
  };
  const svc: any = new OrdersService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  svc.attachCustomerVisitCounts = jest.fn(async (r: any) => r);
  return { svc, calls };
}

const owner = { userId: "u1", tenantId: "t1", role: "OWNER", permissions: [] } as any;

describe("unpaid table-QR prepay orders stay off the board", () => {
  it("leaves them out of the live board", async () => {
    const { svc, calls } = makeService(["unpaid-1", "unpaid-2"]);
    await svc.findLiveOrders(owner, "l1");
    const main = calls[calls.length - 1];
    expect(JSON.stringify(main.where)).toContain('"notIn":["unpaid-1","unpaid-2"]');
  });

  it("leaves them out of order history too", async () => {
    const { svc, calls } = makeService(["unpaid-1"]);
    await svc.findMany(owner, { page: 1, limit: 50, locationId: "l1" });
    const main = calls[calls.length - 1];
    expect(JSON.stringify(main.where)).toContain('"notIn":["unpaid-1"]');
  });

  it("adds nothing when there are none, so every other order is untouched", async () => {
    const { svc, calls } = makeService([]);
    await svc.findLiveOrders(owner, "l1");
    expect(JSON.stringify(calls[calls.length - 1].where)).not.toContain("notIn");
  });

  it("finds them inside the caller's own scope only", async () => {
    const { svc, calls } = makeService([]);
    await svc.findLiveOrders(owner, "l1");
    const lookup = calls.find((c) => c?.select?.id);
    expect(JSON.stringify(lookup.where)).toContain("l1");
    expect(JSON.stringify(lookup.where)).toContain("guestPrepay");
  });

  // The trap. Postgres reads a missing JSON key as NULL, and NOT(pending AND
  // NULL) is NULL, which drops the row. Used inside NOT, this filter would
  // hide every order still awaiting payment: phone cash, staff payment links.
  it("is only ever a positive match, never a NOT", async () => {
    const { svc, calls } = makeService(["x"]);
    await svc.findLiveOrders(owner, "l1");
    await svc.findMany(owner, { page: 1, limit: 50, locationId: "l1" });
    const marker = JSON.stringify(GUEST_PREPAY_UNPAID.metadata);
    for (const c of calls) {
      const notPart = JSON.stringify(c.where?.NOT ?? null) +
        JSON.stringify((c.where?.AND ?? []).map((x: any) => x?.NOT ?? null));
      expect(notPart).not.toContain(marker);
    }
  });

  it("treats money held (AUTHORIZED) and paid as real orders", () => {
    const statuses = (GUEST_PREPAY_UNPAID.paymentStatus as any).in;
    expect(statuses).toEqual(expect.arrayContaining(["PENDING", "FAILED"]));
    expect(statuses).not.toContain("AUTHORIZED");
    expect(statuses).not.toContain("PAID");
  });
});
