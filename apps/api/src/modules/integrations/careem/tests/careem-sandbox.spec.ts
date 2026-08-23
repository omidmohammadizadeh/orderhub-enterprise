import { CareemMockError, CareemSandboxService } from "../careem-sandbox.service";

// The sandbox is only worth having if it says NO in the same places Careem do.
// A mock that answers 200 to everything would let a broken integration look
// finished, which is worse than no mock at all.

const sandbox = () => {
  process.env.CAREEM_SANDBOX = "true";
  process.env.CAREEM_ENV = "staging";
  const s = new CareemSandboxService();
  s.reset();
  return s;
};

const err = (fn: () => unknown): CareemMockError => {
  try {
    fn();
  } catch (e) {
    return e as CareemMockError;
  }
  throw new Error("expected the sandbox to refuse, and it did not");
};

const catalog = (over: Record<string, unknown> = {}) => ({
  diff: false,
  catalog: { id: "loc-1", name: "Main", currency_id: 1, category_ids: [] },
  items: [],
  ...over,
});

describe("CareemSandboxService — enabling", () => {
  it("is off unless asked for", () => {
    process.env.CAREEM_SANDBOX = "false";
    expect(new CareemSandboxService().enabled).toBe(false);
  });

  it("refuses to run against Careem's production", () => {
    // A mock answering while pointed at production would be indistinguishable
    // from a working integration, which is the worst failure available here.
    process.env.CAREEM_SANDBOX = "true";
    process.env.CAREEM_ENV = "production";
    expect(new CareemSandboxService().enabled).toBe(false);
    process.env.CAREEM_ENV = "staging";
  });
});

describe("CareemSandboxService — the rules that block a real integration", () => {
  it("creates a branch UNMAPPED, with POS integration off", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    const branch = s.putBranch("loc-1", "brand-1", { name: "Marina" });
    expect(branch.state).toBe("UNMAPPED");
    expect(branch.pos_integration).toBe(false);
  });

  it("rejects a catalog for an unmapped branch, in their words", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    const e = err(() => s.putCatalog("loc-1", catalog()));
    expect(e.status).toBe(400);
    expect(JSON.stringify(e.payload)).toContain("branch_id is not mapped");
  });

  it("accepts the same catalog once the branch is mapped", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    s.mapBranch("loc-1");
    expect(s.putCatalog("loc-1", catalog())).toHaveProperty("request_id");
  });

  it("rejects a catalog with no currency_id — the field we shipped without", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    s.mapBranch("loc-1");
    const e = err(() =>
      s.putCatalog("loc-1", catalog({ catalog: { id: "loc-1", name: "Main" } })),
    );
    expect(JSON.stringify(e.payload)).toContain("currency_id is required");
  });

  it("409s a second brand with the same name", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    expect(err(() => s.createBrand({ id: "brand-2", name: "Pizza Uno" })).status).toBe(409);
  });

  it("refuses a branch under a brand that does not exist yet", () => {
    const s = sandbox();
    expect(err(() => s.putBranch("loc-1", "brand-1", { name: "Marina" })).status).toBe(400);
  });

  it("rejects 00:00 as an end time", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    const e = err(() =>
      s.putHours("loc-1", {
        operational_hours: [
          { day_of_week: 1, active: true, shifts: [{ start_time: "18:00", end_time: "00:00" }] },
        ],
      }),
    );
    expect(JSON.stringify(e.payload)).toContain("end_at cannot be 00:00");
  });

  it("takes the 23:59 our transformer sends instead", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    expect(
      s.putHours("loc-1", {
        operational_hours: [
          { day_of_week: 1, active: true, shifts: [{ start_time: "18:00", end_time: "23:59" }] },
        ],
      }),
    ).toBeTruthy();
  });

  it("reports the catalog reset endpoint as deprecated", () => {
    const e = err(() => sandbox().deleteCatalog());
    expect(JSON.stringify(e.payload)).toContain("API_DEPRECATED_ERROR");
  });

  it("rejects more than 40 items in one availability call", () => {
    const s = sandbox();
    const items = Array.from({ length: 41 }, (_, i) => ({ id: `i${i}`, status: "active" }));
    expect(err(() => s.patchItems({ items })).status).toBe(400);
  });

  it("pages at 20, as theirs does", () => {
    const s = sandbox();
    for (let i = 0; i < 25; i++) s.createBrand({ id: `b${i}`, name: `Brand ${i}` });
    expect(s.listBrands(1, 20).data).toHaveLength(20);
    expect(s.listBrands(2, 20).data).toHaveLength(5);
  });

  it("will not let a partner reactivate an offline branch", () => {
    const s = sandbox();
    s.createBrand({ id: "brand-1", name: "Pizza Uno" });
    s.putBranch("loc-1", "brand-1", { name: "Marina" });
    // Only Careem operations set or clear `offline`; can_reactivate says so.
    (s as any).branches.get("loc-1").visibility = "offline";
    expect(s.getVisibility("loc-1").can_reactivate).toBe(false);
    expect(err(() => s.setVisibility("loc-1", 1)).status).toBe(403);
  });

  it("records what we sent, including the User-Agent Careem require", () => {
    const s = sandbox();
    s.record({
      method: "PUT",
      path: "/catalogs",
      brandId: "brand-1",
      branchId: "loc-1",
      userAgent: "OrderHub/1.0",
      authorized: true,
      body: {},
      responseStatus: 200,
      response: {},
    });
    expect(s.recent()[0]!.userAgent).toBe("OrderHub/1.0");
  });
});
