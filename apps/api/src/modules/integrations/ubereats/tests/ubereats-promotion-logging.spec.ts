import { UberEatsPromotionsService } from "../ubereats-promotions.service";

// Promotions logged to the Nest logger only, so a create or revoke never
// appeared on the Logs page. That surfaced on 2026-08-20: the operator ran a
// promotion create + remove for Uber's production validation and there was
// nothing to export as evidence. Marketplace validators ask for logs the
// operator can produce; a server-only line cannot be produced.

const CAMPAIGN = {
  id: "camp-1",
  tenantId: "t1",
  brandId: "b1",
  locationId: null,
  name: "20% off everything",
  status: "ACTIVE",
  channels: ["UBER_EATS"],
  type: "PERCENTAGE_OFF",
  percentageOff: 20,
  metadata: {},
};

function makeService(opts: { request?: jest.Mock; campaign?: any } = {}) {
  const request =
    opts.request ??
    jest.fn(async () => ({ promotion_id: "promo-abc" }));
  const campaign = opts.campaign ?? CAMPAIGN;
  const prisma = {
    marketingCampaign: {
      findUnique: jest.fn(async () => campaign),
      update: jest.fn(async () => campaign),
    },
    brandPlatformConnection: {
      findMany: jest.fn(async () => [
        { externalStoreId: "d5989316-cff1-4d93-94f1-e7211e74e9a8" },
      ]),
    },
  } as any;
  const client = { request } as any;
  const activity = { record: jest.fn() } as any;
  return {
    svc: new UberEatsPromotionsService(prisma, client, activity),
    activity,
    request,
  };
}

describe("UberEatsPromotionsService — operator-visible logging", () => {
  it("records a SUCCESS row when a promotion is created", async () => {
    const { svc, activity } = makeService();
    await svc.syncCampaign("camp-1");

    const row = activity.record.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === "promotion.create");
    expect(row).toBeDefined();
    expect(row.status).toBe("SUCCESS");
    expect(row.channel).toBe("UBER_EATS");
    // The store id and promotion id are what a validator cross-references.
    expect(row.details.storeId).toBe("d5989316-cff1-4d93-94f1-e7211e74e9a8");
    expect(row.details.promotionId).toBe("promo-abc");
  });

  it("records an ERROR row when Uber rejects the create", async () => {
    // Previously this vanished — the caller swallowed it and nothing was
    // written, so the operator saw a live campaign that Uber never had.
    const request = jest
      .fn()
      .mockRejectedValue(new Error("400: invalid promo_type"));
    const { svc, activity } = makeService({ request });
    await svc.syncCampaign("camp-1");

    const row = activity.record.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === "promotion.create");
    expect(row.status).toBe("ERROR");
    expect(row.message).toContain("invalid promo_type");
  });

  it("records a SUCCESS row when a promotion is revoked", async () => {
    const campaign = {
      ...CAMPAIGN,
      status: "PAUSED",
      metadata: {
        uberEats: {
          promotions: [
            { storeId: "d5989316-cff1-4d93-94f1-e7211e74e9a8", promotionId: "promo-abc" },
          ],
        },
      },
    };
    const { svc, activity } = makeService({ campaign });
    await svc.syncCampaign("camp-1");

    const row = activity.record.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === "promotion.revoke");
    expect(row).toBeDefined();
    expect(row.status).toBe("SUCCESS");
    expect(row.details.promotionId).toBe("promo-abc");
  });

  it("records an ERROR row when the campaign cannot map to an Uber promotion", async () => {
    // Previously a silent `return` after a logger.warn — the operator saw a
    // live campaign and no promotion, with nothing to explain the gap.
    const { svc, activity } = makeService({
      campaign: { ...CAMPAIGN, percentageOff: 0 },
    });
    await svc.syncCampaign("camp-1");
    const row = activity.record.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === "promotion.create");
    expect(row.status).toBe("ERROR");
    expect(row.message).toMatch(/cannot be sent to Uber Eats/i);
  });

  it("scopes rows to the campaign's brand and tenant", async () => {
    const { svc, activity } = makeService();
    await svc.syncCampaign("camp-1");
    const row = activity.record.mock.calls.map((c: any[]) => c[0])[0];
    expect(row.tenantId).toBe("t1");
    expect(row.brandId).toBe("b1");
  });
});
