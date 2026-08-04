import { BrandsService } from "../brands.service";

// Rolling one brand's application fee out across the estate.
//
// The fee has no location-level form in the dashboard, so it is only ever set
// on a brand — and a brand nobody configured charges nothing. That is how a
// live site took card orders with no platform fee while a sibling brand
// charged normally.
//
// This writes money settings across a whole tenant, so the preview has to be
// exact and the tenant boundary has to hold.

const TENANT = "t1";

const SOURCE = {
  id: "b-source",
  name: "Pizza Uno",
  applicationFeeMode: "fixed_and_percentage",
  applicationFeeFixedAmount: 0.5,
  applicationFeePercentage: 5,
};

function makeService(opts: { source?: any; others?: any[] } = {}) {
  const updates: any[] = [];
  const queries: any[] = [];
  const prisma: any = {
    brand: {
      findFirst: async ({ where }: any) => {
        const s = opts.source === null ? null : (opts.source ?? SOURCE);
        return s && where.id === s.id && where.tenantId === TENANT ? s : null;
      },
      findMany: async ({ where }: any) => {
        queries.push(where);
        return opts.others ?? [];
      },
      updateMany: async (a: any) => {
        updates.push(a);
        return { count: a.where.id.in.length };
      },
    },
  };
  const svc = new BrandsService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, updates, queries };
}

const brand = (id: string, name: string, mode = "none", fixed = 0, pct = 0) => ({
  id,
  name,
  applicationFeeMode: mode,
  applicationFeeFixedAmount: fixed,
  applicationFeePercentage: pct,
});

describe("applyFeeToAllBrands", () => {
  it("writes nothing on a dry run, but reports what would change", async () => {
    const { svc, updates } = makeService({
      others: [brand("b2", "Kingston Pizza")],
    });
    const res = await svc.applyFeeToAllBrands(SOURCE.id, TENANT, {
      dryRun: true,
    });
    expect(updates).toHaveLength(0);
    expect(res.applied).toBe(false);
    expect(res.changes.map((c: any) => c.name)).toEqual(["Kingston Pizza"]);
  });

  it("applies the source's mode and amounts to the brands that differ", async () => {
    const { svc, updates } = makeService({
      others: [brand("b2", "Kingston Pizza")],
    });
    const res = await svc.applyFeeToAllBrands(SOURCE.id, TENANT);
    expect(res.applied).toBe(true);
    expect(updates[0].where.id.in).toEqual(["b2"]);
    expect(updates[0].data).toEqual({
      applicationFeeMode: "fixed_and_percentage",
      applicationFeeFixedAmount: 0.5,
      applicationFeePercentage: 5,
    });
  });

  it("reports what each brand is changing FROM, so a bad apply can be undone", async () => {
    const { svc } = makeService({
      others: [brand("b2", "Kingston Pizza", "percentage_only", 0, 2)],
    });
    const res = await svc.applyFeeToAllBrands(SOURCE.id, TENANT, {
      dryRun: true,
    });
    expect(res.changes[0].from).toEqual({
      mode: "percentage_only",
      fixed: 0,
      percentage: 2,
    });
  });

  it("leaves brands that already match alone", async () => {
    const { svc, updates } = makeService({
      others: [
        brand("b2", "Already Same", "fixed_and_percentage", 0.5, 5),
        brand("b3", "Needs It"),
      ],
    });
    const res = await svc.applyFeeToAllBrands(SOURCE.id, TENANT);
    expect(res.unchanged).toBe(1);
    expect(updates[0].where.id.in).toEqual(["b3"]);
  });

  it("touches nothing when every brand already matches", async () => {
    const { svc, updates } = makeService({
      others: [brand("b2", "Same", "fixed_and_percentage", 0.5, 5)],
    });
    const res = await svc.applyFeeToAllBrands(SOURCE.id, TENANT);
    expect(updates).toHaveLength(0);
    expect(res.applied).toBe(false);
  });

  it("refuses to copy a fee that isn't set — that would zero the estate", async () => {
    const { svc } = makeService({ source: brand("b-source", "No Fee") });
    await expect(
      svc.applyFeeToAllBrands("b-source", TENANT),
    ).rejects.toThrow(/no application fee/i);
  });

  it("scopes the sweep to the tenant and excludes the source", async () => {
    const { svc, queries } = makeService({ others: [] });
    await svc.applyFeeToAllBrands(SOURCE.id, TENANT, { dryRun: true });
    expect(queries[0].tenantId).toBe(TENANT);
    expect(queries[0].id).toEqual({ not: SOURCE.id });
    expect(queries[0].deletedAt).toBeNull();
  });

  it("refuses a brand from another tenant", async () => {
    const { svc } = makeService();
    await expect(
      svc.applyFeeToAllBrands(SOURCE.id, "someone-else"),
    ).rejects.toThrow(/not found/i);
  });
});
