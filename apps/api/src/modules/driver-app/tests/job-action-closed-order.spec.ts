import { BadRequestException } from "@nestjs/common";
import { DriverAppService } from "../driver-app.service";

// A job card can be stale by the time the driver taps it: the operator can
// complete the order on the board, a marketplace webhook can close it, and the
// 5am rollover sweeps up anything left in flight overnight.
//
// Before the guard, tapping that card wrote the order's status regardless —
// so a finished order came back to life on the live board and the dispatch
// map, `outForDeliveryAt` was re-stamped (relighting the customer's tracking
// page), and the resurrection was pushed to HubRise for good measure.
//
// The rule: forward moves on a closed order are refused; the closing actions
// still work, so a driver can always clear the card off their screen without
// touching the order.

function svc(orderStatus: string) {
  const prisma: any = {
    driverAssignment: {
      findFirst: jest.fn().mockResolvedValue({
        id: "a1",
        orderId: "o1",
        driverId: "d1",
        order: { status: orderStatus },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    order: { update: jest.fn().mockResolvedValue({}) },
  };
  const hubriseSync = { pushStatus: jest.fn() };
  const s: any = Object.create(DriverAppService.prototype);
  s.prisma = prisma;
  s.hubriseSync = hubriseSync;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.resolveDriver = jest.fn().mockResolvedValue({ id: "d1", tenantId: "t1" });
  s.upsertPresence = jest.fn().mockResolvedValue({});
  s.emitBoardUpdate = jest.fn().mockResolvedValue(undefined);
  return { s: s as DriverAppService, prisma, hubriseSync };
}

const user: any = { userId: "u1", tenantId: "t1" };

describe("jobAction on an order that has already closed", () => {
  it.each(["accept", "start", "arrived"] as const)(
    "refuses to move a closed order forward with %s",
    async (action) => {
      const { s, prisma, hubriseSync } = svc("COMPLETED");

      await expect(s.jobAction(user, "o1", action)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.driverAssignment.update).not.toHaveBeenCalled();
      expect(hubriseSync.pushStatus).not.toHaveBeenCalled();
    },
  );

  it("still lets the driver clear a stale card, without touching the order", async () => {
    const { s, prisma, hubriseSync } = svc("COMPLETED");

    await s.jobAction(user, "o1", "delivered");

    // The card comes off their screen…
    expect(prisma.driverAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({ status: "DELIVERED" }),
      }),
    );
    // …and the finished order is left exactly as it was.
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(hubriseSync.pushStatus).not.toHaveBeenCalled();
  });

  it("leaves the normal path alone when the order is still live", async () => {
    const { s, prisma, hubriseSync } = svc("OUT_FOR_DELIVERY");

    await s.jobAction(user, "o1", "delivered");

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "o1" },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(hubriseSync.pushStatus).toHaveBeenCalled();
  });

  it("does not fail an order that someone already cancelled", async () => {
    const { s, prisma } = svc("CANCELLED");

    await s.jobAction(user, "o1", "skip");

    expect(prisma.driverAssignment.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "CANCELLED" },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});
