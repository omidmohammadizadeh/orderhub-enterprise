import { CustomersController } from "../customers.controller";
import { LocationAccessService } from "../../../common/access/location-access.service";

// POST /customers/caller-id/ring takes the locationId from the request body and
// broadcasts a caller card into that location's socket room. The phone lookup
// was always scoped to the caller's own tenant — the broadcast was not, so any
// signed-in user could pop a stranger's number onto another tenant's tills (and
// leave a line in that shop's ring diagnostics) just by pasting a location id.
//
// These tests drive the real LocationAccessService against a stub Prisma, so
// the rule under test is the same one the orders board uses rather than a
// re-implementation of it.

type Assignment = { userId: string; locationId: string };

function prismaWith(assignments: Assignment[]) {
  return {
    userLocation: {
      findMany: async ({ where }: any) => assignments.filter((a) => a.userId === where.userId),
    },
    userBrand: { findMany: async () => [] },
    brand: { findMany: async () => [] },
    location: { findMany: async () => [] },
  } as any;
}

function controller(opts: {
  assignments?: Assignment[];
  /** tenant that actually owns the location being rung */
  locationTenant?: string | null;
}) {
  const socket = { emitToLocation: jest.fn() };
  const setup = { record: jest.fn() };
  const customers: any = {
    lookupByPhone: jest.fn(async () => ({ name: "Ada" })),
    tenantForLocation: jest.fn(async () =>
      opts.locationTenant === undefined ? "tenant-1" : opts.locationTenant,
    ),
  };
  const access = new LocationAccessService(prismaWith(opts.assignments ?? []));
  const c = new CustomersController(customers, socket as any, setup as any, access);
  return { c, socket, setup, customers };
}

const staff = (tenantId: string) =>
  ({ userId: "u1", tenantId, role: "MANAGER" }) as any;

describe("POST /customers/caller-id/ring — whose tills may it ring?", () => {
  it("broadcasts for a location the caller is assigned to", async () => {
    const { c, socket, setup } = controller({
      assignments: [{ userId: "u1", locationId: "loc-mine" }],
    });

    const res = await c.callerIdRing(staff("tenant-1"), {
      locationId: "loc-mine",
      phone: "07788187123",
    });

    expect(socket.emitToLocation).toHaveBeenCalledWith(
      "loc-mine",
      "callerid:ring",
      expect.objectContaining({ locationId: "loc-mine", phone: "07788187123" }),
    );
    expect(setup.record).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "loc-mine", source: "comet" }),
    );
    expect(res).toMatchObject({ locationId: "loc-mine", match: { name: "Ada" } });
  });

  // The dashboard's "Send a test ring" button posts the same shape with
  // test: true. It must keep working for the shop's own manager.
  it("still lets the test-ring button fire at the caller's own shop", async () => {
    const { c, socket, setup } = controller({
      assignments: [{ userId: "u1", locationId: "loc-mine" }],
    });

    await c.callerIdRing(staff("tenant-1"), {
      locationId: "loc-mine",
      phone: "07788187123",
      test: true,
    });

    expect(socket.emitToLocation).toHaveBeenCalledTimes(1);
    expect(setup.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: "test" }),
    );
  });

  it("refuses another tenant's location, and emits and records NOTHING", async () => {
    const { c, socket, setup } = controller({
      // No assignment to the foreign shop — which is the only thing the
      // attacker has to get wrong; the id itself is guessable/pasteable.
      assignments: [{ userId: "u1", locationId: "loc-mine" }],
      locationTenant: "tenant-2",
    });

    await expect(
      c.callerIdRing(staff("tenant-1"), {
        locationId: "loc-theirs",
        phone: "07788187123",
      }),
    ).rejects.toThrow(/access to this location/i);

    expect(socket.emitToLocation).not.toHaveBeenCalled();
    expect(setup.record).not.toHaveBeenCalled();
  });

  it("refuses another shop in the caller's OWN tenant the same way", async () => {
    const { c, socket, setup } = controller({
      assignments: [{ userId: "u1", locationId: "loc-mine" }],
      locationTenant: "tenant-1",
    });

    await expect(
      c.callerIdRing(staff("tenant-1"), {
        locationId: "loc-next-door",
        phone: "07788187123",
      }),
    ).rejects.toThrow(/access to this location/i);
    expect(socket.emitToLocation).not.toHaveBeenCalled();
    expect(setup.record).not.toHaveBeenCalled();
  });

  // A tenant-wide role is waved through the per-user check by design, so the
  // tenant check is the ONLY thing standing between an admin and another
  // tenant's tills.
  it("refuses a tenant-wide role ringing outside its own tenant", async () => {
    const { c, socket, setup } = controller({ locationTenant: "tenant-2" });

    await expect(
      c.callerIdRing({ userId: "boss", tenantId: "tenant-1", role: "TENANT_OWNER" } as any, {
        locationId: "loc-theirs",
        phone: "07788187123",
      }),
    ).rejects.toThrow(/access to this location/i);
    expect(socket.emitToLocation).not.toHaveBeenCalled();
    expect(setup.record).not.toHaveBeenCalled();
  });

  it("lets a tenant-wide role ring any shop inside its own tenant", async () => {
    const { c, socket } = controller({ locationTenant: "tenant-1" });

    await c.callerIdRing(
      { userId: "boss", tenantId: "tenant-1", role: "TENANT_OWNER" } as any,
      { locationId: "loc-anywhere", phone: "07788187123" },
    );
    expect(socket.emitToLocation).toHaveBeenCalledWith(
      "loc-anywhere",
      "callerid:ring",
      expect.objectContaining({ locationId: "loc-anywhere" }),
    );
  });

  // assertAccess returns early on a falsy locationId, so without this guard a
  // body with no location would have sailed past the check and on into a
  // Prisma lookup on `undefined`.
  it("rejects a body with no locationId instead of checking nothing", async () => {
    const { c, socket, customers } = controller({});

    await expect(
      c.callerIdRing(staff("tenant-1"), { phone: "07788187123" } as any),
    ).rejects.toThrow(/locationId is required/i);
    expect(socket.emitToLocation).not.toHaveBeenCalled();
    expect(customers.lookupByPhone).not.toHaveBeenCalled();
  });
});
