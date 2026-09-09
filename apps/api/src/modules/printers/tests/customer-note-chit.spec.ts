// The kitchen note a caller leaves for an order nobody can edit.
//
// The first live call took the note, told the caller it had gone through, and
// printed nothing. The job row was created and never announced: the tablet
// bridge prints what it is TOLD about over the socket, so an unannounced job
// sits QUEUED for ever. The round chit has always emitted; this did not.

import { PrintJobsService } from "../print-jobs.service";

describe("printing a customer's note", () => {
  const svc = (targets: any[]) => {
    const created: any[] = [];
    const emitted: any[] = [];
    const s: any = Object.create(PrintJobsService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.prisma = {
      order: { findUnique: async () => ({ id: "ord1", tenantId: "t1", locationId: "loc1" }) },
      printJob: { create: async ({ data }: any) => { created.push(data); return { ...data, id: `job${created.length}` }; } },
    };
    s.routing = { resolveForOrder: jest.fn(async () => targets) };
    s.stampRenderOptions = async () => {};
    s.socket = { emitToLocation: (...a: any[]) => emitted.push(a) };
    return { s, created, emitted };
  };
  const target = {
    type: "KITCHEN_TICKET",
    printerId: "p1",
    stationId: null,
    copies: 1,
    routeKey: "rk",
    payload: { items: [], brandLogoUrl: "https://logo" },
  };

  it("tells the bridge about the job, or no paper ever moves", async () => {
    const { s, created, emitted } = svc([target]);
    const ids = await s.createCustomerNoteChit({ orderId: "ord1", note: "thin crust please", takenBy: "phone 11:04" });

    expect(ids).toEqual(["job1"]);
    expect(created[0].status).toBe("QUEUED");
    expect(emitted).toHaveLength(1);
    const [locationId, event, msg] = emitted[0];
    expect(locationId).toBe("loc1");
    expect(event).toBe("printer:job:created");
    expect(msg.id).toBe("job1");
    expect(msg.printerId).toBe("p1");
    // The logo is stripped for the bridge, same as every other chit.
    expect(msg.payload.brandLogoUrl).toBeUndefined();
  });

  it("puts the note where the kitchen reads it, and warns them off remaking", async () => {
    const { s } = svc([target]);
    await s.createCustomerNoteChit({ orderId: "ord1", note: "thin crust please", takenBy: "phone 11:04" });

    const opts = s.routing.resolveForOrder.mock.calls[0][1];
    expect(opts.kitchenOnly).toBe(true);
    expect(opts.chitNote).toMatch(/DO NOT REMAKE THIS ORDER/);
    expect(opts.chitNote).toMatch(/thin crust please/);
    expect(opts.itemsOverride).toEqual([
      { name: "MESSAGE FROM THE CUSTOMER (phone 11:04)", quantity: 1, notes: "thin crust please" },
    ]);
  });

  it("says nothing printed when there is no printer to print on", async () => {
    const { s, created, emitted } = svc([]);
    expect(await s.createCustomerNoteChit({ orderId: "ord1", note: "thin crust" })).toEqual([]);
    expect(created).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("refuses to print an empty note", async () => {
    const { s } = svc([target]);
    expect(await s.createCustomerNoteChit({ orderId: "ord1", note: "   " })).toEqual([]);
    expect(s.routing.resolveForOrder).not.toHaveBeenCalled();
  });
});
