import { KdsService } from "../kds.service";

// "Has a table number" and "is an open tab" are not the same order.
//
// A TAB is the one growing dine-in order staff settle at the end. It has no
// stage ladder: bumping every station means "this round is cooked", not "the
// meal is over", and READY would block the next addRound. So the KDS leaves
// it alone.
//
// A pay-at-the-table QR round also carries a table number, but it is already
// paid for, is never appended to, and has no Pay & close step to end it. Left
// on the tab rule it would sit in Preparing until the 5am rollover, and a shop
// running the Nando's model would watch its board fill up all service.
//
// The table itself is what tells them apart — currentOrderId is what "the
// open tab" means everywhere else in the system.

function makeService(opts: {
  tableId: string | null;
  /** What the table currently points at, if anything. */
  currentOrderId?: string | null;
}) {
  const progressed: Array<[string, string]> = [];
  const prisma: any = {
    order: {
      findUnique: jest.fn(async ({ select }: any) =>
        select?.tableId !== undefined
          ? { tableId: opts.tableId }
          : { status: "ACCEPTED" },
      ),
    },
    table: {
      findUnique: jest.fn(async () => ({
        currentOrderId: opts.currentOrderId ?? null,
      })),
    },
    // One station screen, already bumped — i.e. the kitchen is done.
    kdsTicket: {
      findMany: jest.fn(async () => [
        {
          bumpedAt: new Date(),
          screen: { settings: { stationType: "GRILL" }, isActive: true },
        },
      ]),
    },
  };

  const svc = Object.create(KdsService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.onOrderProgress = async (id: string, status: string) => {
    progressed.push([id, status]);
  };
  return { svc, progressed };
}

describe("maybeReadyAfterStationBump", () => {
  it("leaves an open tab alone — more rounds are coming", async () => {
    const { svc, progressed } = makeService({
      tableId: "tbl1",
      currentOrderId: "o1",
    });
    await svc.maybeReadyAfterStationBump("o1");
    expect(progressed).toEqual([]);
  });

  it("readies a prepaid table round — nothing will ever be added to it", async () => {
    const { svc, progressed } = makeService({
      tableId: "tbl1",
      // The table has no open tab: this ticket was paid for on a phone.
      currentOrderId: null,
    });
    await svc.maybeReadyAfterStationBump("o1");
    expect(progressed).toEqual([["o1", "READY"]]);
  });

  it("readies a round on a table whose tab is a DIFFERENT order", async () => {
    // A waiter opened a tab for the same table while a guest also paid on
    // their phone. The tab is theirs; this prepaid ticket is not.
    const { svc, progressed } = makeService({
      tableId: "tbl1",
      currentOrderId: "o-waiter-tab",
    });
    await svc.maybeReadyAfterStationBump("o1");
    expect(progressed).toEqual([["o1", "READY"]]);
  });

  it("readies an ordinary ticket with no table at all", async () => {
    const { svc, progressed } = makeService({ tableId: null });
    await svc.maybeReadyAfterStationBump("o1");
    expect(progressed).toEqual([["o1", "READY"]]);
  });
});
