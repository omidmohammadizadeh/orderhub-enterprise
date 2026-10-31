import { CareemConnectionService } from "../careem-connection.service";

// Connecting a real shop. The two things that must never happen: orders turning
// on by themselves, and a second brand at a kitchen overwriting the first.

const baseRow = {
  id: "conn-1",
  tenantId: "t",
  brandId: "brand-1",
  locationId: "loc-1",
  platform: "CAREEM",
  status: "pending",
  externalStoreId: "conn-1",
  lastWebhookAt: null,
  lastError: null,
  metadata: { careemEnv: "production" } as Record<string, unknown>,
};

const build = (over: { row?: unknown; country?: string; branch?: unknown } = {}) => {
  let row: any = over.row === undefined ? { ...baseRow } : over.row;
  const prisma = {
    brand: {
      findFirst: jest.fn().mockResolvedValue({ id: "brand-1", name: "Pizza Uno" }),
    },
    location: {
      findFirst: jest.fn().mockResolvedValue({
        id: "loc-1",
        name: "Dubai Marina",
        country: over.country ?? "AE",
      }),
    },
    brandPlatformConnection: {
      findUnique: jest.fn(async () => row),
      findFirst: jest.fn(async () => row),
      create: jest.fn(async ({ data }: any) => {
        row = { ...baseRow, ...data, id: "new-conn", externalStoreId: null, metadata: {} };
        return row;
      }),
      update: jest.fn(async ({ data }: any) => {
        row = { ...row, ...data };
        return row;
      }),
    },
  };
  const client = { configured: () => true, env: "production" };
  const store = {
    registerBrand: jest.fn().mockResolvedValue({}),
    putBranch: jest.fn().mockResolvedValue({ state: "UNMAPPED" }),
    publishHoursFor: jest.fn().mockResolvedValue({ ok: true }),
    readBranch: jest
      .fn()
      .mockResolvedValue(
        over.branch === undefined ? { state: "UNMAPPED", catalog_id: null } : over.branch,
      ),
    readVisibility: jest.fn().mockResolvedValue({ status: "active" }),
    setPosIntegrationFor: jest.fn().mockResolvedValue({}),
  };
  return {
    svc: new CareemConnectionService(prisma as never, client as never, store as never),
    prisma,
    store,
    current: () => row,
  };
};

describe("CareemConnectionService.connect", () => {
  it("gives a new connection its own branch id and leaves orders off", async () => {
    const { svc, store, current } = build({ row: null });
    await svc.connect("t", { brandId: "brand-1", locationId: "loc-1" });

    expect(store.putBranch).toHaveBeenCalledWith(
      { branchId: "new-conn", brandId: "brand-1", locationId: "loc-1" },
      "Pizza Uno - Dubai Marina",
    );
    expect(store.setPosIntegrationFor).not.toHaveBeenCalled();
    expect(current().externalStoreId).toBe("new-conn");
    expect(current().metadata).toMatchObject({ careemEnv: "production", posIntegration: false });
  });

  it("holds back hours until mapped, because Careem refuse them before that", async () => {
    const { svc, store } = build({ row: null });
    await svc.connect("t", { brandId: "brand-1", locationId: "loc-1" });
    expect(store.publishHoursFor).not.toHaveBeenCalled();
  });

  it("sends hours straight away when the branch is already mapped", async () => {
    const { svc, store } = build({ row: null });
    store.putBranch.mockResolvedValue({ state: "MAPPED" });
    await svc.connect("t", { brandId: "brand-1", locationId: "loc-1" });
    expect(store.publishHoursFor).toHaveBeenCalled();
  });

  it("stays not connected if registering fails, leaving Connect on offer", async () => {
    const { svc, store, current } = build({ row: null });
    store.putBranch.mockRejectedValue(new Error("Careem is down"));
    await expect(
      svc.connect("t", { brandId: "brand-1", locationId: "loc-1" }),
    ).rejects.toThrow("Careem is down");
    expect(current().status).toBe("not_connected");
  });

  it("reuses the branch on reconnect, so Careem need not map it twice", async () => {
    const { svc, store } = build({
      row: { ...baseRow, status: "not_connected", externalStoreId: "old-branch" },
    });
    await svc.connect("t", { brandId: "brand-1", locationId: "loc-1" });
    expect(store.putBranch.mock.calls[0]![0].branchId).toBe("old-branch");
  });

  it("forgets orders-on and the catalog when moving to another environment", async () => {
    const { svc, current } = build({
      row: {
        ...baseRow,
        metadata: { careemEnv: "staging", posIntegration: true, careemCatalog: { status: "COMPLETED" } },
      },
    });
    await svc.connect("t", { brandId: "brand-1", locationId: "loc-1" });
    expect(current().metadata.posIntegration).toBe(false);
    expect(current().metadata.careemCatalog).toBeUndefined();
  });

  it("refuses a shop outside Careem's countries", async () => {
    const { svc, store } = build({ country: "GB" });
    await expect(
      svc.connect("t", { brandId: "brand-1", locationId: "loc-1" }),
    ).rejects.toThrow(/UAE, Jordan and Saudi Arabia/);
    expect(store.registerBrand).not.toHaveBeenCalled();
  });
});

describe("CareemConnectionService.setOrders", () => {
  it("refuses before Careem have mapped the branch", async () => {
    const { svc, store } = build();
    await expect(svc.setOrders("t", "conn-1", true)).rejects.toThrow(/haven't mapped/);
    expect(store.setPosIntegrationFor).not.toHaveBeenCalled();
  });

  it("refuses before a menu is live on the branch", async () => {
    const { svc, store } = build({ branch: { state: "MAPPED", catalog_id: null } });
    await expect(svc.setOrders("t", "conn-1", true)).rejects.toThrow(/Publish the menu/);
    expect(store.setPosIntegrationFor).not.toHaveBeenCalled();
  });

  it("turns on once mapped with a catalog, and the chip follows", async () => {
    const { svc, store, current } = build({ branch: { state: "MAPPED", catalog_id: "conn-1" } });
    const res = await svc.setOrders("t", "conn-1", true);
    expect(store.setPosIntegrationFor).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: "conn-1" }),
      true,
    );
    expect(res.status).toBe("connected");
    expect(current().status).toBe("connected");
  });

  it("can always turn off, whatever state the branch is in", async () => {
    const { svc, store } = build();
    await svc.setOrders("t", "conn-1", false);
    expect(store.setPosIntegrationFor).toHaveBeenCalledWith(expect.anything(), false);
  });
});

describe("CareemConnectionService.health", () => {
  it("flags a branch registered on the other environment without calling Careem", async () => {
    const { svc, store } = build({
      row: { ...baseRow, status: "connected", metadata: { careemEnv: "staging", posIntegration: true } },
    });
    const res = await svc.health("t", "conn-1");
    expect(res.wrongEnvironment).toBe(true);
    expect(store.readBranch).not.toHaveBeenCalled();
  });

  it("does not hand the published item ids to the browser", async () => {
    const { svc } = build({
      row: {
        ...baseRow,
        metadata: { careemEnv: "production", careemCatalog: { status: "COMPLETED", itemIds: ["a"] } },
      },
    });
    const res = await svc.health("t", "conn-1");
    expect(res.catalog).toEqual({ status: "COMPLETED" });
  });

  it("reports Careem being down rather than throwing", async () => {
    const { svc, store } = build();
    store.readBranch.mockRejectedValue(new Error("Careem is down"));
    const res = await svc.health("t", "conn-1");
    expect(res.lastError).toBe("Careem is down");
    expect(res.status).toBe("pending");
  });
});

describe("CareemConnectionService.disconnect", () => {
  const live = {
    ...baseRow,
    status: "connected",
    metadata: { careemEnv: "production", posIntegration: true },
  };

  it("sends orders back to the tablet and keeps the branch id", async () => {
    const { svc, store, current } = build({ row: live });
    await svc.disconnect("t", "conn-1");
    expect(store.setPosIntegrationFor).toHaveBeenCalledWith(expect.anything(), false);
    expect(current().status).toBe("not_connected");
    expect(current().externalStoreId).toBe("conn-1");
  });

  it("stays connected if Careem refuse, rather than hiding live orders", async () => {
    const { svc, store, current } = build({ row: live });
    store.setPosIntegrationFor.mockRejectedValue(new Error("nope"));
    await expect(svc.disconnect("t", "conn-1")).rejects.toThrow("nope");
    expect(current().status).toBe("connected");
  });
});
