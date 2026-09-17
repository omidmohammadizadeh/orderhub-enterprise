import { UberEatsConnectionService } from "../ubereats-connection.service";

// Backing out of a half-finished connection.
//
// Clicking "Connect" sends the operator to Uber's consent page. Whoever is
// signed in to Uber at that moment is whose stores come back, and the row goes
// to "pending" with that person's merchant token on it. If the wrong person
// was signed in — the agency's own account rather than the client's — the card
// offered only "Choose store", and there was no way back to Connect. The
// client's account could not be authorised at all.
//
// disconnect() is the reset. What matters is that it clears the TOKEN as well
// as the status: leaving it behind would mean the next authorisation attempt
// silently reuses the previous person's credentials.

function harness(row: Record<string, unknown> | null) {
  const updates: any[] = [];
  const svc = Object.create(
    UberEatsConnectionService.prototype,
  ) as UberEatsConnectionService;
  (svc as any).prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return args.data;
      }),
    },
  };
  (svc as any).activity = { record: jest.fn() };
  (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, updates };
}

const PENDING_ROW = {
  id: "conn1",
  tenantId: "t1",
  brandId: "b1",
  locationId: "l1",
  platform: "UBER_EATS",
  status: "pending",
  externalStoreId: null,
  metadata: {
    // The merchant token the OAuth callback stored, encrypted.
    credentials: { ciphertext: "…", iv: "…" },
    uberUserId: "someone-elses-account",
  },
};

describe("Uber Eats — resetting a pending connection", () => {
  it("returns the row to not_connected so Connect is offered again", async () => {
    const { svc, updates } = harness(PENDING_ROW);
    await svc.disconnect("t1", "conn1");

    expect(updates[0].data.status).toBe("not_connected");
  });

  it("clears the stored merchant token", async () => {
    // The whole point. A pending row carries the token of whoever authorised;
    // leaving it would let the next attempt reuse the wrong Uber account.
    const { svc, updates } = harness(PENDING_ROW);
    await svc.disconnect("t1", "conn1");

    expect(updates[0].data.metadata).toEqual({});
  });

  it("clears any store already picked", async () => {
    const { svc, updates } = harness({
      ...PENDING_ROW,
      status: "connected",
      externalStoreId: "store-abc",
    });
    await svc.disconnect("t1", "conn1");

    expect(updates[0].data.externalStoreId).toBeNull();
  });

  it("refuses a connection belonging to another tenant", async () => {
    const { svc } = harness(null);
    await expect(svc.disconnect("t1", "conn1")).rejects.toThrow(
      /not found/i,
    );
  });
});
