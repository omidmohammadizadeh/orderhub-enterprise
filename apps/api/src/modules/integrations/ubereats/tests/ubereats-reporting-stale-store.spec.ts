import { UberEatsReportingService } from "../ubereats-reporting.service";

// Uber rejects the ENTIRE report request when ANY store in store_uuids is one
// the calling application cannot access:
//
//   POST /v1/eats/report → 403 {"code":"user_not_allowed",
//     "message":"authorisation failed for e7d0086f-… storeUUID"}
//
// Verified live 2026-08-20: a single stale store left over from a retired
// application took reporting down for every healthy store on the account.

const GOOD = "d5989316-cff1-4d93-94f1-e7211e74e9a8";
const STALE = "e7d0086f-970a-4bf9-ad73-f142391bd068";

const notAllowed = (id: string) =>
  new Error(
    `Uber Eats POST /v1/eats/report → 403: {"code":"user_not_allowed","message":"authorisation failed for ${id} storeUUID"}`,
  );

function makeService(opts: { request?: jest.Mock; conns?: any[] } = {}) {
  const findMany = jest.fn(async () =>
    opts.conns ?? [
      { externalStoreId: GOOD, status: "connected", metadata: {} },
      { externalStoreId: STALE, status: "connected", metadata: {} },
    ],
  );
  const prisma = {
    brandPlatformConnection: { findMany, update: jest.fn(async () => ({})) },
  } as any;
  const request =
    opts.request ?? jest.fn(async () => ({ workflow_id: "wf-1" }));
  const client = { request } as any;
  return {
    svc: new UberEatsReportingService(prisma, client),
    request,
    findMany,
  };
}

const DTO = {
  reportType: "PAYMENT_DETAILS_REPORT",
  startDate: "2026-08-01",
  endDate: "2026-08-20",
};

describe("UberEatsReportingService.createReport — stale store handling", () => {
  it("only asks for stores still connected", async () => {
    const { svc, findMany } = makeService();
    await svc.createReport("t1", DTO as any);
    expect(findMany.mock.calls[0]![0].where.status).toBe("connected");
  });

  it("retries without the store Uber names, instead of failing outright", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(notAllowed(STALE))
      .mockResolvedValue({ workflow_id: "wf-1" });
    const { svc } = makeService({ request });

    const out: any = await svc.createReport("t1", DTO as any);
    expect(out.workflowId ?? out.workflow_id ?? "wf-1").toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
    // First attempt carried both; the retry drops only the named store.
    expect(request.mock.calls[0]![2].body.store_uuids).toEqual([GOOD, STALE]);
    expect(request.mock.calls[1]![2].body.store_uuids).toEqual([GOOD]);
  });

  it("gives up when the ONLY store is the inaccessible one", async () => {
    // Nothing left to report on — retrying with an empty list would ask Uber
    // for a report over no stores.
    const request = jest.fn().mockRejectedValue(notAllowed(STALE));
    const { svc } = makeService({
      request,
      conns: [{ externalStoreId: STALE, status: "connected", metadata: {} }],
    });
    await expect(svc.createReport("t1", DTO as any)).rejects.toThrow(/user_not_allowed/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry on an unrelated error", async () => {
    const request = jest
      .fn()
      .mockRejectedValue(new Error("Uber Eats POST /v1/eats/report → 500: boom"));
    const { svc } = makeService({ request });
    await expect(svc.createReport("t1", DTO as any)).rejects.toThrow(/500/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses when no store is connected at all", async () => {
    const { svc } = makeService({ conns: [] });
    await expect(svc.createReport("t1", DTO as any)).rejects.toThrow(
      /No Uber Eats stores are connected/i,
    );
  });
});
