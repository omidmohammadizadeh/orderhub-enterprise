import { DispatchSettlementService } from "../dispatch-settlement.service";

// Closing the dispatch layer when an order finishes without the driver.
//
// The bug these pin down: an order could reach COMPLETED by four routes (the
// board, a marketplace webhook, a settled tab, the 5am rollover) and only the
// driver's own "delivered" slide ever closed the DriverAssignment. Everything
// else left the job live on the driver's screen and the driver ON_JOB — off
// dispatch's available list — until somebody noticed.
//
// What matters here is the *shape* of the settlement, because two of these
// decisions are about money and one is about a driver's shift:
//   • a completed order pays (DELIVERED); a cancelled one does not;
//   • deliveredAt is the order's own timestamp, not the moment we swept, so
//     the delivery lands in the right day's cash-up;
//   • a driver mid multi-drop stays ON_JOB, and a driver who went home is
//     never quietly put back on shift.

const ONLINE = "ONLINE";
const ON_JOB = "ON_JOB";
const OFFLINE = "OFFLINE";

function svc(overrides: {
  live?: any[];
  stale?: any[];
  remaining?: any[];
  presences?: any[];
}) {
  const prisma: any = {
    driverAssignment: {
      findMany: jest
        .fn()
        // 1st call: the live assignments for the order (settleForOrder) or the
        // stale sweep; 2nd: what that driver still has left.
        .mockResolvedValueOnce(overrides.live ?? overrides.stale ?? [])
        .mockResolvedValue(overrides.remaining ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    driverPresence: {
      findMany: jest.fn().mockResolvedValue(overrides.presences ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  };
  const s: any = Object.create(DispatchSettlementService.prototype);
  s.prisma = prisma;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s: s as DispatchSettlementService, prisma };
}

const YESTERDAY = new Date("2026-09-19T20:14:00.000Z");

describe("DispatchSettlementService", () => {
  it("settles a completed order as DELIVERED and frees the driver", async () => {
    const { s, prisma } = svc({
      live: [{ id: "a1", driverId: "d1" }],
      remaining: [],
      presences: [{ driverId: "d1", status: ON_JOB, activeAssignmentId: "a1" }],
    });

    const result = await s.settleForOrder("o1", "COMPLETED" as any, YESTERDAY);

    expect(result).toEqual({ assignments: 1, driversFreed: 1 });
    expect(prisma.driverAssignment.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "DELIVERED", deliveredAt: YESTERDAY },
    });
    // Back on the available list — not offline, which would end their shift.
    expect(prisma.driverPresence.update).toHaveBeenCalledWith({
      where: { driverId: "d1" },
      data: { status: ONLINE, activeAssignmentId: null },
    });
  });

  it("pays nothing for an order that was cancelled rather than delivered", async () => {
    const { s, prisma } = svc({
      live: [{ id: "a1", driverId: "d1" }],
      presences: [{ driverId: "d1", status: ON_JOB, activeAssignmentId: "a1" }],
    });

    await s.settleForOrder("o1", "CANCELLED" as any, YESTERDAY);

    // CANCELLED, and crucially no deliveredAt: cash-up counts DELIVERED rows,
    // so stamping one here would pay for a delivery that never happened.
    expect(prisma.driverAssignment.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "CANCELLED" },
    });
  });

  it("leaves a driver ON_JOB mid multi-drop and repoints the stale pointer", async () => {
    const { s, prisma } = svc({
      live: [{ id: "a1", driverId: "d1" }],
      remaining: [{ id: "a2", driverId: "d1" }],
      presences: [{ driverId: "d1", status: ON_JOB, activeAssignmentId: "a1" }],
    });

    const result = await s.settleForOrder("o1", "COMPLETED" as any, YESTERDAY);

    expect(result.driversFreed).toBe(0);
    // Repointed at the next stop, never blanked — blanking flickers the app's
    // locked state in the middle of a run.
    expect(prisma.driverPresence.update).toHaveBeenCalledWith({
      where: { driverId: "d1" },
      data: { activeAssignmentId: "a2" },
    });
  });

  it("does not put a driver who went home back on shift", async () => {
    const { s, prisma } = svc({
      live: [{ id: "a1", driverId: "d1" }],
      remaining: [],
      presences: [{ driverId: "d1", status: OFFLINE, activeAssignmentId: "a1" }],
    });

    const result = await s.settleForOrder("o1", "COMPLETED" as any, YESTERDAY);

    expect(result.driversFreed).toBe(0);
    expect(prisma.driverPresence.update).toHaveBeenCalledWith({
      where: { driverId: "d1" },
      data: { activeAssignmentId: null },
    });
  });

  it("is a no-op for an order with no live assignment", async () => {
    const { s, prisma } = svc({ live: [] });

    const result = await s.settleForOrder("o1", "COMPLETED" as any, YESTERDAY);

    expect(result).toEqual({ assignments: 0, driversFreed: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.driverPresence.findMany).not.toHaveBeenCalled();
  });

  it("does nothing for a status that is not terminal", async () => {
    const { s, prisma } = svc({ live: [{ id: "a1", driverId: "d1" }] });

    const result = await s.settleForOrder("o1", "OUT_FOR_DELIVERY" as any, YESTERDAY);

    expect(result).toEqual({ assignments: 0, driversFreed: 0 });
    // Not even a lookup: a live order must never touch the assignment.
    expect(prisma.driverAssignment.findMany).not.toHaveBeenCalled();
  });

  it("sweeps stranded assignments using the order's own finish time", async () => {
    const { s, prisma } = svc({
      stale: [
        {
          id: "a1",
          driverId: "d1",
          order: { status: "COMPLETED", updatedAt: YESTERDAY },
        },
        {
          id: "a2",
          driverId: "d2",
          order: { status: "FAILED", updatedAt: YESTERDAY },
        },
      ],
      remaining: [],
      presences: [
        { driverId: "d1", status: ON_JOB, activeAssignmentId: "a1" },
        { driverId: "d2", status: ON_JOB, activeAssignmentId: "a2" },
      ],
    });

    const result = await s.sweepTerminalOrders();

    expect(result).toEqual({ assignments: 2, driversFreed: 2 });
    // Yesterday's delivery is stamped yesterday, so it lands in the cash-up it
    // belongs to instead of inflating this morning's.
    expect(prisma.driverAssignment.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "DELIVERED", deliveredAt: YESTERDAY },
    });
    expect(prisma.driverAssignment.update).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: { status: "CANCELLED" },
    });
  });

  it("sweeps nothing when every assignment's order is still live", async () => {
    const { s, prisma } = svc({ stale: [] });

    expect(await s.sweepTerminalOrders()).toEqual({
      assignments: 0,
      driversFreed: 0,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
