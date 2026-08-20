import { UberEatsConnectionService } from "../ubereats-connection.service";

// Uber's Basic production validation (case 59403755, 2026-08-20) names three
// calls we did not previously make. The gap that actually blocked us was
// DELETE: `disconnect()` only unlinked our own row — "there's no pos_data to
// tear down" — so Uber kept believing the store was integrated, the
// `store.deprovisioned` webhook could never fire, and their prescribed
// sequence (DELETE → deprovisioned → POST re-activate) was impossible.

const CONN = {
  id: "conn-1",
  tenantId: "t1",
  brandId: "b1",
  locationId: "l1",
  platform: "UBER_EATS",
  externalStoreId: "d5989316-cff1-4d93-94f1-e7211e74e9a8",
  metadata: {},
};

function makeService(opts: { connection?: any; request?: jest.Mock } = {}) {
  const calls: any[] = [];
  const request = opts.request ?? jest.fn(async (method: string, path: string, o: any = {}) => {
    calls.push({ method, path, ...o });
    if (o?.meta) o.meta.status = method === "DELETE" ? 204 : 200;
    return {};
  });
  const updated: any[] = [];
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn(async () =>
        opts.connection === undefined ? CONN : opts.connection,
      ),
      update: jest.fn(async (a: any) => {
        updated.push(a);
        return CONN;
      }),
    },
  } as any;
  const client = { request } as any;
  const oauth = { merchantToken: jest.fn(async () => "merchant-token") } as any;
  const activity = { record: jest.fn() } as any;
  const svc = new UberEatsConnectionService(prisma, client, oauth, activity as any);
  return { svc, request, calls, updated, activity };
}

describe("UberEatsConnectionService.deprovision", () => {
  it("DELETEs pos_data on Uber, not just our own row", async () => {
    const { svc, calls } = makeService();
    await svc.deprovision("t1", "conn-1");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del).toBeDefined();
    expect(del.path).toBe(
      "/v1/eats/stores/d5989316-cff1-4d93-94f1-e7211e74e9a8/pos_data",
    );
  });

  it("uses the MERCHANT token — the same credential that provisioned the store", async () => {
    const { svc, calls } = makeService();
    await svc.deprovision("t1", "conn-1");
    expect(calls.find((c) => c.method === "DELETE").userToken).toBe("merchant-token");
  });

  it("carries the pos_data API version header", async () => {
    const { svc, calls } = makeService();
    await svc.deprovision("t1", "conn-1");
    expect(calls.find((c) => c.method === "DELETE").posDataVersion).toBe(true);
  });

  it("KEEPS externalStoreId so the deprovisioned webhook can still find us", async () => {
    // The webhook resolves the connection BY Uber store id. Clearing it here
    // would orphan the callback and strand the row as "connected".
    const { svc, updated } = makeService();
    await svc.deprovision("t1", "conn-1");
    const data = updated.at(-1).data;
    expect(data.status).toBe("pending");
    expect("externalStoreId" in data).toBe(false);
  });

  it("logs the teardown for the operator, flagging the pending webhook", async () => {
    const { svc, activity } = makeService();
    await svc.deprovision("t1", "conn-1");
    const entry = activity.record.mock.calls.at(-1)[0];
    expect(entry.action).toBe("integration.deprovisioned");
    expect(entry.message).toMatch(/store\.deprovisioned/);
  });

  it("refuses when no Uber store is linked", async () => {
    const { svc } = makeService({ connection: { ...CONN, externalStoreId: null } });
    await expect(svc.deprovision("t1", "conn-1")).rejects.toThrow(
      /isn't connected/i,
    );
  });
});

describe("UberEatsConnectionService.patchPosData", () => {
  it("PATCHes the same document POST creates", async () => {
    const { svc, calls } = makeService();
    await svc.patchPosData("t1", "conn-1", { require_manual_acceptance: false });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.path).toBe(
      "/v1/eats/stores/d5989316-cff1-4d93-94f1-e7211e74e9a8/pos_data",
    );
    expect(patch.body).toEqual({ require_manual_acceptance: false });
    expect(patch.posDataVersion).toBe(true);
  });

  it("uses CLIENT-CREDENTIALS with eats.store, not the merchant token", async () => {
    // Uber rejects the merchant token here — verified live 2026-08-20:
    // 401 "This endpoint requires at least one of the following scopes:
    // eats.store" — even though the POST that creates the same document
    // takes it. Provisioning is a merchant action; editing the record is
    // store-scoped.
    const { svc, calls } = makeService();
    await svc.patchPosData("t1", "conn-1", {});
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.scopes).toEqual(["eats.store"]);
    expect(patch.userToken).toBeUndefined();
  });

  it("falls back to the merchant token if the scoped call 401s", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error("Uber Eats PATCH … → 401: unauthorized"))
      .mockImplementation(async (_m: string, _p: string, o: any = {}) => {
        if (o?.meta) o.meta.status = 200;
        return {};
      });
    const { svc } = makeService({ request });
    const res = await svc.patchPosData("t1", "conn-1", {});
    expect(res.httpStatus).toBe(200);
    expect(request.mock.calls[1][2].userToken).toBe("merchant-token");
  });

  it("sends a meaningful body when the caller supplies none", async () => {
    // An empty PATCH body is a wasted validation call — re-assert the two
    // fields that actually matter instead.
    const { svc, calls } = makeService();
    await svc.patchPosData("t1", "conn-1", {});
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({
      integration_enabled: true,
      is_order_manager: true,
    });
  });

  it("records the HTTP status the operator can quote back to Uber", async () => {
    const { svc, activity } = makeService();
    const res = await svc.patchPosData("t1", "conn-1", {});
    expect(res.httpStatus).toBe(200);
    expect(activity.record.mock.calls.at(-1)[0].action).toBe("integration.patched");
  });
});
