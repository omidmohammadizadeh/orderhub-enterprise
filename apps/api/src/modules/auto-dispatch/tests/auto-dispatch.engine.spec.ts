import { AutoDispatchService } from "../auto-dispatch.service";

// The engine end to end against fakes: a due run is claimed once, the
// cheapest bookable provider is booked through its own DispatchService, a
// refusal falls through to the next one, a dry run books nothing, and an
// order someone dispatched by hand in the meantime is left alone.

function harness(opts: {
  rule?: Record<string, any>;
  order?: Record<string, any>;
  prices?: Record<string, number | Error>;
  refuse?: string[];
}) {
  const rule = {
    id: "r1",
    tenantId: "t1",
    name: "Cheapest",
    enabled: true,
    priority: 1,
    locationId: null,
    brandIds: [],
    channels: [],
    strategy: "CHEAPEST",
    providers: ["STUART", "UBER_DIRECT", "JET_GO"],
    fallback: true,
    trigger: "ON_ACCEPT",
    delayMinutes: 0,
    maxPriceMinor: null,
    dryRun: false,
    enabledAt: new Date(0),
    createdAt: new Date(0),
    ...opts.rule,
  };
  const order = {
    id: "o1",
    tenantId: "t1",
    locationId: "loc1",
    brandId: "b1",
    orderSource: "DIRECT",
    status: "ACCEPTED",
    fulfillmentType: "DELIVERY",
    deliveryType: null,
    courierJobId: null,
    acceptedAt: new Date(),
    readyAt: null,
    estimatedReadyAt: null,
    preparationMinutes: null,
    scheduledFor: null,
    createdAt: new Date(),
    displayId: "ABC",
    driverAssignment: null,
    ...opts.order,
  };
  const runs: any[] = [];
  const prisma: any = {
    autoDispatchRule: {
      findMany: jest.fn(async () => [rule]),
      findUnique: jest.fn(async () => rule),
    },
    order: {
      findMany: jest.fn(async () => [order]),
      findUnique: jest.fn(async () => order),
    },
    location: { findUnique: jest.fn(async () => ({ prepTime: 20 })) },
    autoDispatchRun: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.orderId) return runs.filter((r) => where.orderId.in.includes(r.orderId));
        if (where?.status === "SCHEDULED") {
          return runs.filter((r) => r.status === "SCHEDULED" && r.dueAt <= where.dueAt.lte);
        }
        return [];
      }),
      create: jest.fn(async ({ data }: any) => {
        if (runs.some((r) => r.orderId === data.orderId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const row = { id: `run${runs.length + 1}`, status: "SCHEDULED", attempts: 0, ...data };
        runs.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = runs.find((x) => x.id === where.id && x.status === where.status);
        if (!r) return { count: 0 };
        r.status = data.status;
        r.attempts += 1;
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = runs.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
  };
  const prices = opts.prices ?? { STUART: 7.5, UBER_DIRECT: 5.2, JET_GO: 6 };
  const booked: string[] = [];
  const provider = (name: string) => ({
    quote: jest.fn(async () => {
      const p = prices[name];
      if (p instanceof Error) throw p;
      return { amount: p, currency: "GBP" };
    }),
    dispatch: jest.fn(async () => {
      if (opts.refuse?.includes(name)) throw new Error(`${name} refused`);
      booked.push(name);
      return { jobId: `${name}-job` };
    }),
  });
  const stuart = provider("STUART");
  const uber = provider("UBER_DIRECT");
  const jet = provider("JET_GO");
  const yango = provider("YANGO");
  const svc = new AutoDispatchService(
    prisma,
    stuart as any,
    {} as any,
    uber as any,
    {} as any,
    jet as any,
    {} as any,
    yango as any,
    {} as any,
    { record: jest.fn() } as any,
  );
  return { svc, runs, booked, order };
}

describe("AutoDispatchService.tick", () => {
  it("books the cheapest quote, once", async () => {
    const h = harness({});
    await h.svc.tick();
    await h.svc.tick();
    expect(h.booked).toEqual(["UBER_DIRECT"]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ status: "DISPATCHED", provider: "UBER_DIRECT", priceMinor: 520 });
  });

  it("falls through to the next cheapest when one refuses", async () => {
    const h = harness({ refuse: ["UBER_DIRECT"] });
    await h.svc.tick();
    expect(h.booked).toEqual(["JET_GO"]);
    expect(h.runs[0].status).toBe("DISPATCHED");
  });

  it("a dry run quotes but books nothing", async () => {
    const h = harness({ rule: { dryRun: true } });
    await h.svc.tick();
    expect(h.booked).toEqual([]);
    expect(h.runs[0]).toMatchObject({ status: "DRY_RUN", provider: "UBER_DIRECT" });
  });

  it("FIXED books the named provider without quoting", async () => {
    const h = harness({ rule: { strategy: "FIXED", providers: ["JET_GO"] }, prices: {} });
    await h.svc.tick();
    expect(h.booked).toEqual(["JET_GO"]);
  });

  it("leaves an order someone dispatched by hand after it was scheduled", async () => {
    const h = harness({ rule: { delayMinutes: 5 } });
    await h.svc.tick();
    expect(h.runs[0].status).toBe("SCHEDULED");
    h.order.courierJobId = "manual";
    await h.svc.tick(new Date(Date.now() + 6 * 60_000));
    expect(h.booked).toEqual([]);
    expect(h.runs[0].status).toBe("SKIPPED");
  });

  it("retries later when no provider can take it", async () => {
    const h = harness({ prices: { STUART: new Error("out of range"), UBER_DIRECT: new Error("x"), JET_GO: new Error("y") } });
    await h.svc.tick();
    expect(h.booked).toEqual([]);
    expect(h.runs[0].status).toBe("SCHEDULED");
    expect(h.runs[0].dueAt.getTime()).toBeGreaterThan(Date.now());
  });
});
