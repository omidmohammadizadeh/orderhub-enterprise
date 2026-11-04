import { CustomerPushService } from "../customer-push.service";

// An Eat For Less order belongs to the app's customer. Its updates go to the
// phones signed in to that account — never to the shop's own subscribers —
// and a token Expo says is gone is switched off in the Eat For Less table.

function setup(order: any, devices: any[]) {
  const eflUpdateMany = jest.fn(async () => ({}));
  const prisma: any = {
    order: { findUnique: jest.fn(async () => order) },
    eflPushDevice: { findMany: jest.fn(async () => devices), updateMany: eflUpdateMany },
    customerPushOrder: { findMany: jest.fn(async () => []) },
    customerPushSubscription: { updateMany: jest.fn(async () => ({})) },
  };
  return { svc: new CustomerPushService(prisma), prisma, eflUpdateMany };
}

describe("Eat For Less order pushes", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("sends to the customer's devices and skips the shop's subscribers", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] }),
    }));
    global.fetch = fetchMock as any;
    const { svc, prisma, eflUpdateMany } = setup(
      { orderSource: "EAT_FOR_LESS", customerAccountId: "c1", outForDeliveryAt: new Date(), brand: { name: "Pizza Pizza" } },
      [
        { id: "d1", token: "ExponentPushToken[aaa]" },
        { id: "d2", token: "ExponentPushToken[bbb]" },
      ],
    );

    await svc.notifyOrderStatus({ orderId: "o1", status: "OUT_FOR_DELIVERY", displayId: "AB12C" });

    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.map((m: any) => m.to)).toEqual(["ExponentPushToken[aaa]", "ExponentPushToken[bbb]"]);
    expect(sent[0].data).toMatchObject({ orderId: "o1", app: "eatforless" });
    expect(prisma.customerPushOrder.findMany).not.toHaveBeenCalled();
    // The gone token is revoked in the Eat For Less table, not the shop's.
    expect(eflUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["d2"] } }, data: expect.objectContaining({ isActive: false }) }),
    );
    expect(prisma.customerPushSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a shop's own order to the shop's subscribers", async () => {
    const { svc, prisma } = setup({ orderSource: "ONLINE", customerAccountId: "c1" }, []);
    await svc.notifyOrderStatus({ orderId: "o1", status: "ACCEPTED" });
    expect(prisma.eflPushDevice.findMany).not.toHaveBeenCalled();
    expect(prisma.customerPushOrder.findMany).toHaveBeenCalled();
  });

  it("doesn't tell the customer a courier at the shop is at their door", async () => {
    const { svc, prisma } = setup({ orderSource: "EAT_FOR_LESS", customerAccountId: "c1", outForDeliveryAt: null }, []);
    await svc.notifyOrderStatus({ orderId: "o1", status: "RIDER_ARRIVED" });
    expect(prisma.eflPushDevice.findMany).not.toHaveBeenCalled();
  });
});
