import { BadRequestException } from "@nestjs/common";
import { MenuAutoPublishService } from "../menu-auto-publish.service";

function setup() {
  const rows: any[] = [];
  const calls: string[] = [];
  const logs: any[] = [];
  const prisma: any = {
    menu: {
      findFirst: async ({ where }: any) =>
        where.id === "m1" && where.brand.tenantId === "t1"
          ? { id: "m1", name: "Monster Burgerz", brandId: "b1", locationId: "loc-home" }
          : null,
    },
    location: { findUnique: async () => ({ name: "Pizza Planet", country: "GB" }) },
    menuChannelAssignment: {
      findMany: async () => [
        { channel: "JUST_EAT", locationId: "loc-a", brandId: "b1", location: { name: "Tonypandy" } },
        { channel: "JUST_EAT", locationId: "loc-b", brandId: "b1", location: { name: "Pelton" } },
        { channel: "JUST_EAT", locationId: "loc-a", brandId: "b2", location: { name: "Tonypandy" } }, // dup location
      ],
    },
    menuAutoPublish: {
      findUnique: async ({ where }: any) => rows.find((r) => r.menuId === where.menuId) ?? null,
      upsert: async ({ create, update, where }: any) => {
        const r = rows.find((x) => x.menuId === where.menuId);
        if (r) return Object.assign(r, update, { updatedAt: new Date() });
        const n = { id: "s1", ...create, updatedAt: new Date() };
        rows.push(n);
        return n;
      },
      update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
      findMany: async () => rows.filter((r) => r.enabled && r.nextRunAt && r.nextRunAt <= new Date()),
      updateMany: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id && x.nextRunAt === where.nextRunAt);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 1 }),
    },
  };
  const ok = (name: string) => async (a: any) => void calls.push(`${name}:${a.locationId ?? "-"}`);
  const svc = new MenuAutoPublishService(
    prisma,
    { publishMenu: ok("hubrise") } as any,
    { publishMenu: async (a: any) => { calls.push(`deliveroo:${a.locationId}`); throw new Error("Deliveroo store not connected"); } } as any,
    { publishMenu: ok("uber") } as any,
    { publishMenu: ok("jet") } as any,
    { record: (e: any) => logs.push(e) } as any,
  );
  return { svc, rows, calls, logs };
}

describe("MenuAutoPublishService", () => {
  it("validates a schedule and computes the next run in the menu's timezone", async () => {
    const { svc } = setup();
    await expect(svc.save("m1", "t1", { channels: [], days: [1], times: ["10:45"] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save("m1", "t1", { channels: ["JUST_EAT"], days: [], times: ["10:45"] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save("m1", "t1", { channels: ["JUST_EAT"], days: [1], times: ["nope"] })).rejects.toBeInstanceOf(BadRequestException);
    const s = await svc.save("m1", "t1", { channels: ["JUST_EAT", "FAX", "JUST_EAT"], days: [3, 1, 9], times: ["17:00", "10:45", "10:45"] });
    expect(s.channels).toEqual(["JUST_EAT"]);
    expect(s.days).toEqual([1, 3]);
    expect(s.times).toEqual(["10:45", "17:00"]);
    expect(s.timezone).toBe("Europe/London");
    expect(s.nextRunAt).toBeInstanceOf(Date);
    // Turning it off needs no channels and clears the next run.
    const off = await svc.save("m1", "t1", { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.nextRunAt).toBeNull();
  });

  it("publishes once per served location, records a partial result and logs each", async () => {
    const { svc, calls, rows, logs } = setup();
    await svc.save("m1", "t1", { channels: ["JUST_EAT", "DELIVEROO"], days: [0, 1, 2, 3, 4, 5, 6], times: ["10:45"] });
    const r = await svc.runNow("m1", "t1");
    // JET: two distinct locations (the duplicate brand row is not published twice).
    // Deliveroo: no assignment → falls back to the menu's home location, and fails.
    expect(calls).toEqual(["jet:loc-a", "jet:loc-b", "deliveroo:loc-home"]);
    expect(r.status).toBe("partial");
    expect(r.results.find((x) => x.channel === "DELIVEROO")).toMatchObject({ ok: false, message: "Deliveroo store not connected" });
    expect(rows[0].lastStatus).toBe("partial");
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ category: "MENU", channel: "JUST_EAT", action: "menu.auto_publish", status: "SUCCESS" });
  });

  it("fires a due schedule exactly once and moves it to the next slot", async () => {
    const { svc, rows, calls } = setup();
    await svc.save("m1", "t1", { channels: ["HUBRISE"], days: [0, 1, 2, 3, 4, 5, 6], times: ["10:45"] });
    rows[0].nextRunAt = new Date(Date.now() - 60_000); // overdue
    await Promise.all([svc.tick(), svc.tick()]); // overlapping ticks
    expect(calls).toEqual(["hubrise:-"]); // one catalog push, no location
    expect(rows[0].nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].lastStatus).toBe("ok");
    await svc.tick(); // not due any more
    expect(calls).toHaveLength(1);
  });

  it("refuses another tenant's menu and run-now without a schedule", async () => {
    const { svc } = setup();
    await expect(svc.get("m1", "t2")).rejects.toThrow("Menu not found");
    await expect(svc.runNow("m1", "t1")).rejects.toThrow("Save the auto-publish schedule first");
  });
});
