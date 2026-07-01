import { DeliverooConnectionService } from "../deliveroo-connection.service";

// Regression: Deliveroo's Site API wants the opening-hours map WRAPPED under
// `opening_hours`. Posting the bare map is accepted (2xx) but silently
// ignored, so "publish" reported success while nothing changed on Deliveroo.

interface Call {
  method: string;
  path: string;
  body: any;
}

function makeService(openingHours: any) {
  const calls: Call[] = [];
  const client = {
    request: (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      return Promise.resolve({});
    },
  } as any;
  const prisma = {
    brandPlatformConnection: {
      findFirst: () =>
        Promise.resolve({
          id: "conn-1",
          tenantId: "t-1",
          locationId: "loc-1",
          externalStoreId: "site-1",
          externalBrandId: "brand-1",
        }),
    },
    location: {
      findUnique: () =>
        Promise.resolve({
          openingHours,
          prepTime: 20,
          busyExtraPrepTime: 10,
          brand: { openingHours: null, prepTime: null },
        }),
    },
  } as any;
  return { svc: new DeliverooConnectionService(prisma, client), calls };
}

describe("DeliverooConnectionService.publishHours", () => {
  it("wraps the opening-hours map under `opening_hours`", async () => {
    const { svc, calls } = makeService({
      monday: { enabled: true, slots: [{ from: "09:00", to: "22:00" }] },
    });
    await svc.publishHours("t-1", "conn-1");

    const hoursCall = calls.find((c) => c.path.endsWith("/opening_hours"));
    expect(hoursCall).toBeDefined();
    expect(hoursCall!.method).toBe("POST");
    expect(hoursCall!.path).toBe(
      "/site/v1/brands/brand-1/sites/site-1/opening_hours",
    );
    // The load-bearing assertion: the map is nested, not sent bare.
    expect(hoursCall!.body).toEqual({
      opening_hours: {
        monday: [{ local_start_time: "09:00", local_end_time: "22:00" }],
      },
    });
  });

  it("still pushes prep time, and skips the hours call when empty", async () => {
    const { svc, calls } = makeService(null);
    await svc.publishHours("t-1", "conn-1");

    expect(calls.find((c) => c.path.endsWith("/opening_hours"))).toBeUndefined();
    const prep = calls.find((c) => c.path.endsWith("/workload/times"));
    expect(prep).toBeDefined();
    expect(prep!.method).toBe("PUT");
    expect(prep!.body).toEqual({ quiet: 20, moderate: 20, busy: 30 });
  });
});
