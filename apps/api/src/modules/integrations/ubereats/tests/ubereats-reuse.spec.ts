import { BadRequestException } from "@nestjs/common";
import { UberEatsConnectionService } from "../ubereats-connection.service";

// "Reuse an existing connection."
//
// GET /v1/delivery/stores returns EVERY store the authorising user owns, so a
// five-shop client's first authorisation already covers all five. The only
// reason they were asked to sign in again per shop is that we keep the
// merchant token on the per-location row.
//
// Reuse copies that token onto the new brand+location and lands it in the same
// "pending" state the OAuth callback produces, so the existing store picker
// takes over with no further consent.

function harness(opts: { rows?: any[]; target?: any } = {}) {
  const updates: any[] = [];
  const upserts: any[] = [];
  const svc = Object.create(
    UberEatsConnectionService.prototype,
  ) as UberEatsConnectionService;
  (svc as any).prisma = {
    brandPlatformConnection: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      findFirst: jest.fn(async ({ where }: any) =>
        where?.id
          ? (opts.rows ?? []).find((r: any) => r.id === where.id) ?? null
          : opts.target ?? null,
      ),
      upsert: jest.fn(async (args: any) => {
        upserts.push(args);
        return { id: "new-conn" };
      }),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return args.data;
      }),
    },
    brand: { findFirst: jest.fn().mockResolvedValue({ id: "b2", name: "Yoyo" }) },
  };
  (svc as any).activity = { record: jest.fn() };
  (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, upserts, updates };
}

const SOURCE = {
  id: "conn-a",
  tenantId: "t1",
  brandId: "b1",
  locationId: "l1",
  platform: "UBER_EATS",
  status: "connected",
  externalStoreId: "store-1",
  brand: { name: "Monster Burgerz" },
  location: { name: "Clifton" },
  metadata: { credentials: { ciphertext: "cipher", iv: "iv" } },
};

describe("Uber Eats — reusing an authorisation", () => {
  it("offers connections that actually hold a token", async () => {
    const { svc } = harness({ rows: [SOURCE] });
    const out = await (svc as any).listReusable("t1");

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ connectionId: "conn-a" });
  });

  it("does not offer one whose token was cleared", async () => {
    // A reset connection has status not_connected and empty metadata. Offering
    // it would produce a pending row with no credentials — a dead end the
    // operator can only escape by resetting again.
    const { svc } = harness({
      rows: [{ ...SOURCE, status: "not_connected", metadata: {} }],
    });
    expect(await (svc as any).listReusable("t1")).toHaveLength(0);
  });

  it("copies the token onto the new brand and leaves it pending", async () => {
    const { svc, upserts } = harness({ rows: [SOURCE] });
    await (svc as any).reuse("t1", {
      fromConnectionId: "conn-a",
      brandId: "b2",
      locationId: "l2",
    });

    const data = upserts[0].create ?? upserts[0].update;
    expect(upserts[0].update.status).toBe("pending");
    expect(upserts[0].update.metadata.credentials).toEqual(
      SOURCE.metadata.credentials,
    );
    expect(data).toBeTruthy();
  });

  it("never copies the source's store id", async () => {
    // The whole point is to pick a DIFFERENT store from the same account.
    // Carrying the store across would silently point two shops at one store.
    const { svc, upserts } = harness({ rows: [SOURCE] });
    await (svc as any).reuse("t1", {
      fromConnectionId: "conn-a",
      brandId: "b2",
      locationId: "l2",
    });

    expect(upserts[0].update.externalStoreId).toBeNull();
  });

  it("refuses a source from another tenant", async () => {
    const { svc } = harness({ rows: [] });
    await expect(
      (svc as any).reuse("t1", {
        fromConnectionId: "conn-a",
        brandId: "b2",
        locationId: "l2",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to reuse a connection onto itself", async () => {
    const { svc } = harness({ rows: [SOURCE] });
    await expect(
      (svc as any).reuse("t1", {
        fromConnectionId: "conn-a",
        brandId: "b1",
        locationId: "l1",
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
