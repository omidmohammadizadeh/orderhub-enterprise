import { BadRequestException } from "@nestjs/common";
import { DriverAppService } from "../../driver-app/driver-app.service";
import { EflCallsService, ensureCallLine } from "../efl-calls.service";
import {
  CALL_LINE_HOURS_AFTER,
  MAX_PIN_ATTEMPTS,
  callLineOpen,
  checkDeliveryPin,
  generateCallCode,
  normaliseKeyedCode,
} from "../efl-rules";

const now = new Date("2026-10-27T18:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

describe("checkDeliveryPin", () => {
  const base = { expected: "0427", attempts: 0, verified: false };

  it("passes the right PIN, leading zero and all", () => {
    expect(checkDeliveryPin({ ...base, given: "0427" })).toEqual({ ok: true });
    expect(checkDeliveryPin({ ...base, given: " 04 27 " })).toEqual({ ok: true });
  });

  it("passes when there is no PIN, or it was already verified", () => {
    expect(checkDeliveryPin({ ...base, expected: null, given: "" })).toEqual({ ok: true });
    expect(checkDeliveryPin({ ...base, verified: true, given: "" })).toEqual({ ok: true });
  });

  it("asks for a PIN without counting an empty one as a try", () => {
    const r = checkDeliveryPin({ ...base, given: "" });
    expect(r).toMatchObject({ ok: false, locked: false, attemptsLeft: MAX_PIN_ATTEMPTS });
  });

  it("counts down wrong PINs and locks on the third", () => {
    expect(checkDeliveryPin({ ...base, given: "1111", attempts: 0 })).toMatchObject({ ok: false, locked: false, attemptsLeft: 2 });
    expect(checkDeliveryPin({ ...base, given: "1111", attempts: 1 })).toMatchObject({ ok: false, locked: false, attemptsLeft: 1 });
    expect(checkDeliveryPin({ ...base, given: "1111", attempts: 2 })).toMatchObject({ ok: false, locked: true });
  });

  it("stays locked even for the right PIN once locked", () => {
    expect(checkDeliveryPin({ ...base, given: "0427", attempts: 3 })).toMatchObject({ ok: false, locked: true });
  });
});

describe("callLineOpen", () => {
  it("is open while the order is live", () => {
    expect(callLineOpen({ status: "OUT_FOR_DELIVERY" }, now)).toBe(true);
    expect(callLineOpen({ status: "PREPARING" }, now)).toBe(true);
  });

  it("closes on a cancelled, rejected or failed order", () => {
    for (const status of ["CANCELLED", "REJECTED", "FAILED"]) expect(callLineOpen({ status }, now)).toBe(false);
  });

  it(`stays open ${CALL_LINE_HOURS_AFTER}h after delivery, then closes`, () => {
    expect(callLineOpen({ status: "COMPLETED", deliveredAt: hoursAgo(1.9) }, now)).toBe(true);
    expect(callLineOpen({ status: "COMPLETED", deliveredAt: hoursAgo(2.1) }, now)).toBe(false);
    // Completed on the board: no deliveredAt, so the last update counts.
    expect(callLineOpen({ status: "COMPLETED", deliveredAt: null, updatedAt: hoursAgo(1) }, now)).toBe(true);
  });
});

describe("call codes", () => {
  it("are six digits", () => {
    for (let i = 0; i < 50; i++) expect(generateCallCode()).toMatch(/^\d{6}$/);
  });
  it("read keyed digits without the hash", () => {
    expect(normaliseKeyedCode("123456#")).toBe("123456");
    expect(normaliseKeyedCode(undefined)).toBe("");
  });
});

describe("ensureCallLine", () => {
  it("returns the order's existing line rather than new codes", async () => {
    const line = { orderId: "o1", customerCode: "111111", driverCode: "222222" };
    const prisma: any = { eflCallLine: { findUnique: jest.fn().mockResolvedValue(line), upsert: jest.fn() } };
    await expect(ensureCallLine(prisma, "o1")).resolves.toBe(line);
    expect(prisma.eflCallLine.upsert).not.toHaveBeenCalled();
  });

  it("makes two different codes for a new line", async () => {
    const prisma: any = {
      eflCallLine: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(async ({ create }: any) => create),
      },
      order: { findMany: jest.fn() },
    };
    const line = await ensureCallLine(prisma, "o1");
    expect(line.customerCode).toMatch(/^\d{6}$/);
    expect(line.driverCode).toMatch(/^\d{6}$/);
    expect(line.customerCode).not.toBe(line.driverCode);
  });
});

describe("EflCallsService", () => {
  function setup(opts: { order?: any; assignment?: any; line?: any } = {}) {
    const line = opts.line ?? { orderId: "o1", customerCode: "111111", driverCode: "222222" };
    const prisma: any = {
      eflCallLine: { findMany: jest.fn().mockResolvedValue([line]) },
      order: {
        findUnique: jest.fn().mockResolvedValue(
          opts.order ?? {
            status: "OUT_FOR_DELIVERY",
            customerPhone: "+447700900001",
            location: { phone: "0191 000 0000" },
          },
        ),
      },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(opts.assignment ?? null) },
    };
    const telnyx: any = {
      answer: jest.fn().mockResolvedValue(true),
      gatherDigits: jest.fn().mockResolvedValue(true),
      transfer: jest.fn().mockResolvedValue(true),
      speak: jest.fn().mockResolvedValue(true),
      hangup: jest.fn().mockResolvedValue(true),
      markEnded: jest.fn(),
    };
    const config: any = { get: (k: string) => (k === "EFL_CALL_NUMBER" ? "+441910000001" : undefined) };
    return { svc: new EflCallsService(prisma, config, telnyx), telnyx, prisma };
  }

  it("connects the driver's code to the customer", async () => {
    const { svc } = setup();
    await expect(svc.targetFor("222222#", now)).resolves.toEqual({ to: "+447700900001", who: "customer" });
  });

  it("connects the customer's code to the driver once one has the food", async () => {
    const { svc } = setup({ assignment: { driver: { phone: "+447700900009" } } });
    await expect(svc.targetFor("111111", now)).resolves.toEqual({ to: "+447700900009", who: "driver" });
  });

  it("connects the customer to the shop before a driver has it", async () => {
    const { svc } = setup();
    await expect(svc.targetFor("111111", now)).resolves.toEqual({ to: "0191 000 0000", who: "shop" });
  });

  it("refuses a closed line and a short code", async () => {
    const { svc } = setup({ order: { status: "COMPLETED", deliveredAt: hoursAgo(3), customerPhone: "+447700900001" } });
    await expect(svc.targetFor("222222", now)).resolves.toBeNull();
    await expect(svc.targetFor("2222", now)).resolves.toBeNull();
  });

  it("answers, asks for the code, and transfers from our own number", async () => {
    const { svc, telnyx } = setup();
    await svc.onEvent("call.initiated", { call_control_id: "c1", direction: "incoming" });
    await svc.onEvent("call.answered", { call_control_id: "c1", direction: "incoming" });
    await svc.onEvent("call.gather.ended", { call_control_id: "c1", digits: "222222" });
    expect(telnyx.answer).toHaveBeenCalledWith("c1");
    expect(telnyx.gatherDigits).toHaveBeenCalledTimes(1);
    expect(telnyx.transfer).toHaveBeenCalledWith("c1", "+447700900001", "+441910000001");
  });

  it("never answers its own transfer leg", async () => {
    const { svc, telnyx } = setup();
    await svc.onEvent("call.initiated", { call_control_id: "c2", direction: "outgoing" });
    await svc.onEvent("call.answered", { call_control_id: "c2", direction: "outgoing" });
    expect(telnyx.answer).not.toHaveBeenCalled();
    expect(telnyx.gatherDigits).not.toHaveBeenCalled();
  });

  it("asks again after a wrong code, and says goodbye after the third", async () => {
    const { svc, telnyx, prisma } = setup();
    prisma.eflCallLine.findMany.mockResolvedValue([]);
    for (let i = 0; i < 3; i++) await svc.onEvent("call.gather.ended", { call_control_id: "c1", digits: "999999" });
    expect(telnyx.gatherDigits).toHaveBeenCalledTimes(2);
    expect(telnyx.speak).toHaveBeenCalledTimes(1);
    await svc.onEvent("call.speak.ended", { call_control_id: "c1" });
    expect(telnyx.hangup).toHaveBeenCalledWith("c1");
    expect(telnyx.transfer).not.toHaveBeenCalled();
  });
});

describe("driver handover PIN", () => {
  function driverSvc(order: { deliveryPin: string | null; deliveryPinVerifiedAt?: Date | null; deliveryPinAttempts?: number }) {
    const prisma: any = {
      driverAssignment: {
        findFirst: jest.fn().mockResolvedValue({ id: "a1", orderId: "o1", driverId: "d1", order: { status: "RIDER_ARRIVED" } }),
        update: jest.fn().mockResolvedValue({}),
      },
      order: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ deliveryPinVerifiedAt: null, deliveryPinAttempts: 0, ...order }),
      },
    };
    const s: any = Object.create(DriverAppService.prototype);
    s.prisma = prisma;
    s.hubriseSync = { pushStatus: jest.fn() };
    s.customerPush = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) };
    s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    s.resolveDriver = jest.fn().mockResolvedValue({ id: "d1", tenantId: "t1" });
    s.upsertPresence = jest.fn().mockResolvedValue({});
    s.emitBoardUpdate = jest.fn().mockResolvedValue(undefined);
    return { s: s as DriverAppService, prisma };
  }
  const user: any = { userId: "u1", tenantId: "t1" };
  const completed = (prisma: any) =>
    prisma.order.update.mock.calls.some(([a]: any) => a.data?.status === "COMPLETED");

  it("refuses delivered without a PIN, and an old app gets told why", async () => {
    const { s, prisma } = driverSvc({ deliveryPin: "0427" });
    await expect(s.jobAction(user, "o1", "delivered")).rejects.toBeInstanceOf(BadRequestException);
    expect(completed(prisma)).toBe(false);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("counts a wrong PIN and doesn't complete", async () => {
    const { s, prisma } = driverSvc({ deliveryPin: "0427" });
    await expect(s.jobAction(user, "o1", "delivered", { pin: "1234" })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { deliveryPinAttempts: { increment: 1 } } });
    expect(completed(prisma)).toBe(false);
  });

  it("completes with the right PIN and stamps it verified", async () => {
    const { s, prisma } = driverSvc({ deliveryPin: "0427" });
    await s.jobAction(user, "o1", "delivered", { pin: "0427" });
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { deliveryPinVerifiedAt: expect.any(Date) } });
    expect(completed(prisma)).toBe(true);
  });

  it("leaves orders without a PIN exactly as before", async () => {
    const { s, prisma } = driverSvc({ deliveryPin: null });
    await s.jobAction(user, "o1", "delivered");
    expect(completed(prisma)).toBe(true);
  });
});
