import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DispatchService } from "../dispatch.service";

// "Return to board" pulls a stop back off a driver. It used to check only the
// tenant and never the state, so a manager scoped to one shop could pull
// another shop's orders, and a delivered order could be flipped back to READY.

const manager: any = { userId: "u1", tenantId: "t1", role: "MANAGER" };

function svcWith(opts: {
  assignment?: { status: string } | null;
  order?: Record<string, any> | null;
  accessible?: string[];
}) {
  const writes: any[] = [];
  const prisma: any = {
    driverAssignment: {
      findUnique: jest.fn(async () =>
        opts.assignment === null ? null : { id: "a1", driverId: "d1", ...(opts.assignment ?? { status: "ASSIGNED" }) },
      ),
      update: jest.fn(async (args: any) => {
        writes.push({ model: "assignment", ...args });
        return {};
      }),
      count: jest.fn(async () => 0),
    },
    order: {
      findFirst: jest.fn(async () =>
        opts.order === null
          ? null
          : { id: "o1", status: "READY", locationId: "loc-1", displayId: "#1001", orderNumber: null, ...opts.order },
      ),
      update: jest.fn(async (args: any) => {
        writes.push({ model: "order", ...args });
        return {};
      }),
    },
    driverPresence: { update: jest.fn().mockResolvedValue({}) },
  };
  const s: any = Object.create(DispatchService.prototype);
  s.prisma = prisma;
  s.resolveAccessibleLocationIds = jest.fn().mockResolvedValue(opts.accessible ?? ["loc-1"]);
  return { s: s as DispatchService, writes };
}

describe("DispatchService.unassign", () => {
  it("puts a live stop back on the board", async () => {
    const { s, writes } = svcWith({ assignment: { status: "PICKED_UP" }, order: { status: "OUT_FOR_DELIVERY" } });
    await expect(s.unassign(manager, "o1")).resolves.toEqual({ ok: true });
    expect(writes.find((w) => w.model === "order")?.data).toEqual({ status: "READY" });
    expect(writes.find((w) => w.model === "assignment")?.data).toEqual({ status: "CANCELLED" });
  });

  it("refuses an order in a shop the caller can't reach, and writes nothing", async () => {
    const { s, writes } = svcWith({ order: { locationId: "loc-2" } });
    await expect(s.unassign(manager, "o1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes).toHaveLength(0);
  });

  it("never resurrects a delivered order", async () => {
    const { s, writes } = svcWith({ assignment: { status: "DELIVERED" }, order: { status: "COMPLETED" } });
    await expect(s.unassign(manager, "o1")).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the order already ended even if the assignment lagged behind", async () => {
    const { s, writes } = svcWith({ assignment: { status: "ACCEPTED" }, order: { status: "CANCELLED" } });
    await expect(s.unassign(manager, "o1")).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toHaveLength(0);
  });

  it("is a no-op when nothing is assigned", async () => {
    const { s, writes } = svcWith({ assignment: null });
    await expect(s.unassign(manager, "o1")).resolves.toEqual({ ok: true });
    expect(writes).toHaveLength(0);
  });
});
