import { EflPresenceService, OFFLINE_AFTER_MS, presenceChange } from "../efl-presence.service";

const now = new Date("2026-10-25T18:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("presenceChange", () => {
  it("hides a shop after 2 minutes with no device", () => {
    expect(presenceChange({ hiddenReason: null, lastDeviceSeenAt: ago(OFFLINE_AFTER_MS - 1000), online: false, now })).toBe("NONE");
    expect(presenceChange({ hiddenReason: null, lastDeviceSeenAt: ago(OFFLINE_AFTER_MS), online: false, now })).toBe("GO_OFFLINE");
  });

  it("hides a shop that has never had a device online", () => {
    expect(presenceChange({ hiddenReason: null, lastDeviceSeenAt: null, online: false, now })).toBe("GO_OFFLINE");
  });

  it("brings an offline shop back as soon as a device connects", () => {
    expect(presenceChange({ hiddenReason: "OFFLINE", lastDeviceSeenAt: ago(9e6), online: true, now })).toBe("COME_BACK");
  });

  it("never touches a shop hidden for another reason", () => {
    expect(presenceChange({ hiddenReason: "HYGIENE", lastDeviceSeenAt: null, online: false, now })).toBe("NONE");
    expect(presenceChange({ hiddenReason: "HYGIENE", lastDeviceSeenAt: null, online: true, now })).toBe("NONE");
  });
});

describe("EflPresenceService.check", () => {
  function setup(listings: any[], online: string[]) {
    const update = jest.fn(async () => ({}));
    const updateMany = jest.fn(async () => ({}));
    const prisma: any = { eflListing: { findMany: jest.fn(async () => listings), update, updateMany } };
    const socket: any = { locationsWithShopDevices: jest.fn(async () => new Set(online)) };
    return { svc: new EflPresenceService(prisma, socket), update, updateMany };
  }
  const shop = (id: string, extra: any = {}) => ({
    id,
    locationId: `loc_${id}`,
    hiddenReason: null,
    lastDeviceSeenAt: ago(10_000),
    location: { name: id, phone: null, openingHours: null, timezone: "Europe/London", brand: { name: id } },
    ...extra,
  });

  it("stamps shops with a device and hides the ones gone quiet", async () => {
    const { svc, update, updateMany } = setup(
      [shop("a"), shop("b", { lastDeviceSeenAt: ago(5 * 60_000) })],
      ["loc_a"],
    );
    await svc.check(now);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a"] } }, data: { lastDeviceSeenAt: now } });
    expect(update).toHaveBeenCalledWith({ where: { id: "b" }, data: { hiddenReason: "OFFLINE", offlineSince: now } });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("restores a shop whose tablet came back", async () => {
    const { svc, update } = setup([shop("a", { hiddenReason: "OFFLINE" })], ["loc_a"]);
    await svc.check(now);
    expect(update).toHaveBeenCalledWith({ where: { id: "a" }, data: { hiddenReason: null, offlineSince: null } });
  });
});
