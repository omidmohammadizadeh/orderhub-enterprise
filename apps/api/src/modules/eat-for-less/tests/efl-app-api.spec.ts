import { EflService } from "../efl.service";
import { EflAccountService, isExpoPushToken } from "../efl-account.service";
import { deliveryWindow, travelMinutes } from "../efl-rules";

describe("myOrder", () => {
  function setup(driver: any) {
    const prisma: any = {
      order: {
        findFirst: jest.fn(async () => ({ id: "o1", deliveryPin: "4821", deliveryPinVerifiedAt: null })),
      },
    };
    const ordering: any = {
      getOrderStatus: jest.fn(async () => ({
        id: "o1",
        status: "OUT_FOR_DELIVERY",
        destination: { lat: 54.97, lng: -1.61 },
        driver,
      })),
    };
    return new EflService(prisma, ordering, {} as any, {} as any);
  }

  it("never returns the driver's own phone number", async () => {
    const res: any = await setup({ name: "Dan", phone: "+447700900111", lat: 54.98, lng: -1.62 }).myOrder({ id: "c1" }, "o1");
    expect(res.driver).toEqual({ name: "Dan", lat: 54.98, lng: -1.62 });
    expect(JSON.stringify(res)).not.toContain("+447700900111");
  });

  it("estimates the driver's arrival from their last position", async () => {
    const res: any = await setup({ name: "Dan", phone: "x", lat: 54.98, lng: -1.62 }).myOrder({ id: "c1" }, "o1");
    expect(res.driverEtaMinutes).toBeGreaterThan(0);
    expect(res.deliveryPin).toBe("4821");
  });

  it("has no ETA without a driver position", async () => {
    const res: any = await setup(null).myOrder({ id: "c1" }, "o1");
    expect(res.driver).toBeNull();
    expect(res.driverEtaMinutes).toBeNull();
  });
});

describe("delivery time", () => {
  it("adds the doorstep minutes to the drive", () => {
    expect(travelMinutes(0)).toBe(3);
    expect(travelMinutes(2)).toBe(13);
  });

  it("shows a 10-minute window on 5-minute steps", () => {
    expect(deliveryWindow(20, 2)).toEqual({ min: 30, max: 40 });
    const w = deliveryWindow(45, 0.4);
    expect(w.max - w.min).toBe(10);
    expect(w.min % 5).toBe(0);
  });
});

describe("isExpoPushToken", () => {
  it("accepts both Expo token prefixes and nothing else", () => {
    expect(isExpoPushToken("ExponentPushToken[abc123_-X]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("https://fcm.googleapis.com/x")).toBe(false);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
  });
});

describe("saved addresses", () => {
  function setup(existing: number) {
    const tx: any = {
      eflSavedAddress: {
        updateMany: jest.fn(async () => ({})),
        create: jest.fn(async (args: any) => args.data),
      },
    };
    const prisma: any = {
      eflSavedAddress: { count: jest.fn(async () => existing) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return { service: new EflAccountService(prisma), tx };
  }

  const address = { line1: " 14 Grey Street ", city: "Newcastle", postcode: "ne1 6ae" };

  it("makes the first address the default and tidies it", async () => {
    const { service, tx } = setup(0);
    const saved: any = await service.addAddress({ id: "c1" }, address);
    expect(saved).toMatchObject({ isDefault: true, line1: "14 Grey Street", postcode: "NE1 6AE", customerAccountId: "c1" });
    expect(tx.eflSavedAddress.updateMany).toHaveBeenCalled();
  });

  it("leaves the existing default alone for a second address", async () => {
    const { service, tx } = setup(1);
    const saved: any = await service.addAddress({ id: "c1" }, address);
    expect(saved.isDefault).toBe(false);
    expect(tx.eflSavedAddress.updateMany).not.toHaveBeenCalled();
  });

  it("stops at ten addresses", async () => {
    const { service } = setup(10);
    await expect(service.addAddress({ id: "c1" }, address)).rejects.toThrow(/up to 10/);
  });
});
