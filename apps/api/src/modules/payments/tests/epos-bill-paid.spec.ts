// What a table still owes.
//
// Dojo's terminal subtracts `paidAmount` from the total and asks the customer
// for the rest, so this number IS the amount a diner is charged. Two ways to
// get it wrong, both real money:
//
//   - count a refunded payment as still paid → the table is undercharged
//   - miss a part payment entirely → the customer pays that part twice
//
// The second one was live on the till until 2026-09-25: the POS order payload
// carries no payments, so "Pay & close" offered the whole total on a tab that
// already had £4.13 banked. Dojo's bill got it right, which is how it was found.

import { DojoEposService } from "../dojo/dojo-epos.service";

function makeService() {
  const svc = Object.create(DojoEposService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.prisma = { table: { findUnique: async () => ({ name: "TABLE 2", serverId: null }) } };
  return svc;
}

const ctx = {
  loc: { id: "loc1", name: "Pizza Uno", country: "GB", address: {}, phone: null },
  cfg: {} as any,
  tenantId: "t1",
};

const order = (payments: any[]) => ({
  id: "o1",
  displayId: "9X6NP",
  status: "ACCEPTED",
  paymentStatus: "PENDING",
  total: 26.72,
  createdAt: new Date("2026-09-25T11:43:05.950Z"),
  updatedAt: new Date("2026-09-25T11:54:38.553Z"),
  tableId: "tbl1",
  items: [],
  payments,
});

describe("the bill Dojo shows a diner", () => {
  it("counts a whole payment as paid", async () => {
    const svc = makeService();
    const out = await svc.toDojoOrder(ctx, order([{ id: "p1", amount: 4.13, metadata: {} }]));
    expect(out.paidAmount).toEqual({ value: 413, currencyCode: "GBP" });
    expect(out.payments).toHaveLength(1);
  });

  it("counts only what's left of a part-refunded payment", async () => {
    // £10 taken, £4 given back — the table has paid £6, not £10. Counting the
    // full £10 would let the diner walk out £4 light.
    const svc = makeService();
    const out = await svc.toDojoOrder(
      ctx,
      order([{ id: "p1", amount: 10, metadata: { refundedMinor: 400 } }]),
    );
    expect(out.paidAmount).toEqual({ value: 600, currencyCode: "GBP" });
    expect(out.payments[0].paidAmount).toEqual({ value: 600, currencyCode: "GBP" });
  });

  it("drops a payment that has been refunded down to nothing", async () => {
    const svc = makeService();
    const out = await svc.toDojoOrder(
      ctx,
      order([{ id: "p1", amount: 10, metadata: { refundedMinor: 1000 } }]),
    );
    expect(out.paidAmount).toEqual({ value: 0, currencyCode: "GBP" });
    // Not listed either: a line reading "£0.00 paid" on a bill is noise.
    expect(out.payments).toHaveLength(0);
  });

  it("never lets an over-refund make the bill look bigger than it is", async () => {
    const svc = makeService();
    const out = await svc.toDojoOrder(
      ctx,
      order([{ id: "p1", amount: 10, metadata: { refundedMinor: 1500 } }]),
    );
    expect(out.paidAmount).toEqual({ value: 0, currencyCode: "GBP" });
  });

  it("still asks for money while any of the bill is outstanding", async () => {
    const svc = makeService();
    const part = await svc.toDojoOrder(ctx, order([{ id: "p1", amount: 4.13, metadata: {} }]));
    expect(part.payable).toBe(true);

    const settled = await svc.toDojoOrder(ctx, order([{ id: "p1", amount: 26.72, metadata: {} }]));
    expect(settled.payable).toBe(false);
  });
});
