import { PauseService } from "../pause.service";

// Phase BA-2 — "Stop taking orders" must close the brand's DIRECT Deliveroo
// store (and Resume reopen it), the same as the per-brand Open/Pause buttons.
// PauseService.reconcileDeliveroo pushes OPEN/CLOSED to match the live pause
// state. These tests drive that private reconcile directly (the pause/resume
// callers fire it best-effort).

function makeService(opts: {
  activePauseRows: any[];
  deliverooConns: any[];
}) {
  const setStoreOpen = jest.fn().mockResolvedValue({ status: "OPEN" });
  const prisma = {
    // isPaused() reads channelPause; return the active rows verbatim.
    channelPause: { findMany: jest.fn().mockResolvedValue(opts.activePauseRows) },
    brandPlatformConnection: {
      findMany: jest.fn().mockResolvedValue(opts.deliverooConns),
    },
    brand: { findUnique: jest.fn().mockResolvedValue({ name: "Brand" }) },
  } as any;
  const hubrise = {} as any;
  const deliveroo = { setStoreOpen } as any;
  const svc = new PauseService(prisma, hubrise, deliveroo);
  return { svc, setStoreOpen, prisma };
}

const pausedRow = {
  id: "p-1",
  brandId: null,
  channel: null,
  mode: "paused",
  resumeAt: null,
  reason: "Closing early",
  pausedAt: new Date("2026-07-01T18:00:00Z"),
};

describe("PauseService → direct Deliveroo store", () => {
  it("CLOSES the Deliveroo store when a pause covers it", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [
        // externalBrandId is part of a real row — reconcileDeliveroo now
        // checks it explicitly instead of relying on the query to guarantee it.
        {
          id: "conn-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });

    await (svc as any).reconcileDeliveroo(
      { locationId: "loc-1", brandId: null, channel: null },
      "t-1",
    );

    expect(setStoreOpen).toHaveBeenCalledTimes(1);
    expect(setStoreOpen).toHaveBeenCalledWith("t-1", "conn-1", false);
  });

  it("REOPENS the Deliveroo store when nothing keeps it paused", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [], // no active pause → open
      deliverooConns: [
        // externalBrandId is part of a real row — reconcileDeliveroo now
        // checks it explicitly instead of relying on the query to guarantee it.
        {
          id: "conn-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });

    await (svc as any).reconcileDeliveroo(
      { locationId: "loc-1", brandId: null, channel: null },
      "t-1",
    );

    expect(setStoreOpen).toHaveBeenCalledWith("t-1", "conn-1", true);
  });

  it("does NOT touch Deliveroo for a non-Deliveroo channel pause", async () => {
    const { svc, setStoreOpen, prisma } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [
        // externalBrandId is part of a real row — reconcileDeliveroo now
        // checks it explicitly instead of relying on the query to guarantee it.
        {
          id: "conn-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });

    await (svc as any).reconcileDeliveroo(
      { locationId: "loc-1", brandId: null, channel: "UBER_EATS" },
      "t-1",
    );

    expect(prisma.brandPlatformConnection.findMany).not.toHaveBeenCalled();
    expect(setStoreOpen).not.toHaveBeenCalled();
  });

  it("acts on a Deliveroo-channel pause", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [{ ...pausedRow, channel: "DELIVEROO" }],
      deliverooConns: [
        // externalBrandId is part of a real row — reconcileDeliveroo now
        // checks it explicitly instead of relying on the query to guarantee it.
        {
          id: "conn-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });

    await (svc as any).reconcileDeliveroo(
      { locationId: "loc-1", brandId: "b-1", channel: "DELIVEROO" },
      "t-1",
    );

    expect(setStoreOpen).toHaveBeenCalledWith("t-1", "conn-1", false);
  });

  it("swallows Deliveroo API failures (never throws)", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [
        // externalBrandId is part of a real row — reconcileDeliveroo now
        // checks it explicitly instead of relying on the query to guarantee it.
        {
          id: "conn-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });
    setStoreOpen.mockRejectedValueOnce(new Error("Deliveroo 500"));

    await expect(
      (svc as any).reconcileDeliveroo(
        { locationId: "loc-1", brandId: null, channel: null },
        "t-1",
      ),
    ).resolves.toBeUndefined();
  });
});

// The gap the tests above did not cover: they mock findMany, so the WHERE
// clause was never exercised. The query used to require externalBrandId,
// which no other platform's reconcile did — a connection missing it was
// dropped before any of the logic below ever ran, and nothing was logged.
describe("PauseService → Deliveroo connections the query used to drop", () => {
  it("does not filter on externalBrandId — that silence was the bug", async () => {
    const { svc, prisma } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [],
    });

    await (svc as any).reconcileDeliveroo(
      { locationId: "loc-1" },
      "t-1",
    );

    const where = prisma.brandPlatformConnection.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("externalBrandId");
    // The conditions that genuinely matter are still there.
    expect(where.platform).toBe("DELIVEROO");
    expect(where.externalStoreId).toEqual({ not: null });
  });

  it("reports a connection with no brand id instead of skipping it quietly", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [
        { id: "c-1", brandId: "b-1", tenantId: "t-1", externalBrandId: null },
      ],
    });
    const record = jest.fn();
    (svc as any).activity = { record };

    await (svc as any).reconcileDeliveroo({ locationId: "loc-1" }, "t-1");

    // Can't be called — the URL needs the brand id — but the operator must
    // be told, because their shop is still taking Deliveroo orders.
    expect(setStoreOpen).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "DELIVEROO", status: "ERROR" }),
    );
  });

  it("still closes a connection that has one", async () => {
    const { svc, setStoreOpen } = makeService({
      activePauseRows: [pausedRow],
      deliverooConns: [
        {
          id: "c-1",
          brandId: "b-1",
          tenantId: "t-1",
          externalBrandId: "the-grill-stop-gb",
        },
      ],
    });

    await (svc as any).reconcileDeliveroo({ locationId: "loc-1" }, "t-1");

    expect(setStoreOpen).toHaveBeenCalledWith("t-1", "c-1", false);
  });
});
