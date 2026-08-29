import { NotFoundException } from "@nestjs/common";
import { ChatService } from "../chat.service";

// Who can read a driver's conversation.
//
// The operator inbox was scoped to the TENANT: every manager at every shop
// saw every driver's chat, including shops they have no access to at all.
// These tests pin the scope down at both doors — the list, and the thread
// you can reach by id without the list.

const TENANT = "t1";
const LOC_A = "loc-best-kebab";
const LOC_B = "loc-castle-grill";

const DRIVERS = [
  { id: "d-a", firstName: "Ash", lastName: "F", locationId: LOC_A, presence: null },
  { id: "d-b", firstName: "Dil", lastName: "T", locationId: LOC_B, presence: null },
  { id: "d-none", firstName: "Var", lastName: "R", locationId: null, presence: null },
];

function makeService(assignedLocations: string[]) {
  const prisma: any = {
    driver: {
      findMany: jest.fn(({ where }: any) => {
        const scope = where.OR
          ? (d: any) =>
              where.OR.some((o: any) =>
                o.locationId === null
                  ? d.locationId === null
                  : o.locationId.in.includes(d.locationId),
              )
          : (d: any) => d.locationId === where.locationId;
        return Promise.resolve(DRIVERS.filter(scope));
      }),
      findFirst: jest.fn(({ where }: any) => {
        const rows = DRIVERS.filter((d) =>
          where.OR
            ? where.OR.some((o: any) =>
                o.locationId === null
                  ? d.locationId === null
                  : o.locationId.in.includes(d.locationId),
              )
            : true,
        );
        return Promise.resolve(rows.find((d) => d.id === where.id) ?? null);
      }),
    },
    chatMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    userLocation: {
      findMany: jest
        .fn()
        .mockResolvedValue(assignedLocations.map((locationId) => ({ locationId }))),
    },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
    location: { findMany: jest.fn().mockResolvedValue([]) },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc: any = Object.create(ChatService.prototype);
  svc.prisma = prisma;
  return svc as ChatService & any;
}

const user = { userId: "u1", tenantId: TENANT, role: "MANAGER" as const };

describe("ChatService — operator inbox scope", () => {
  it("shows only the drivers at the shops this manager is assigned to", async () => {
    const svc = makeService([LOC_A]);
    const threads = await svc.operatorThreads(user);
    expect(threads.map((t: any) => t.driverId).sort()).toEqual(["d-a", "d-none"]);
  });

  it("narrows further to one shop when the dashboard picks one", async () => {
    const svc = makeService([LOC_A, LOC_B]);
    const threads = await svc.operatorThreads(user, LOC_B);
    expect(threads.map((t: any) => t.driverId)).toEqual(["d-b"]);
  });

  it("returns nothing for a shop the caller has no claim to", async () => {
    // The id comes from a dropdown in a browser, so asking for someone else's
    // shop must not reach past the caller's own assignments.
    const svc = makeService([LOC_A]);
    expect(await svc.operatorThreads(user, LOC_B)).toEqual([]);
  });

  it("shows nothing at all to a manager with no assignments", async () => {
    const svc = makeService([]);
    expect(await svc.operatorThreads(user)).toEqual([]);
  });
});

describe("ChatService — reaching a thread by id", () => {
  it("refuses another shop's driver even though the id is valid", async () => {
    const svc = makeService([LOC_A]);
    await expect(svc.assertDriverInScope(user, "d-b")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("allows a driver at the caller's own shop", async () => {
    const svc = makeService([LOC_A]);
    await expect(svc.assertDriverInScope(user, "d-a")).resolves.toBeUndefined();
  });
});
