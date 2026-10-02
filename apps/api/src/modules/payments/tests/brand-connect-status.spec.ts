import { PaymentsService } from "../payments.service";

// The Payments page lists one payout row per brand. Two things went wrong the
// first time a Dubai test brand was looked at there (2026-10-02):
//   1. it was hidden, because the list only showed brands selling online —
//      but a Gulf brand's Tap merchant is also what QR pay-at-table charges;
//   2. its country came from Brand.country (default GB) / its own locations
//      (none — it lives at a kitchen via primaryLocationId), so it would have
//      been offered Stripe, which can never work in the UAE.

function build(brands: any[], primaryLocs: Array<{ id: string; country: string }>) {
  const prisma: any = {
    location: {
      findFirst: async () => ({ id: "locDXB", brandId: "parent" }),
      findMany: async () => primaryLocs,
    },
    brand: { findMany: async () => brands },
    stripeConnectAccount: { findMany: async () => [] },
  };
  const config: any = { get: () => undefined };
  return new PaymentsService(prisma, {} as any, config, {} as any, {} as any, {} as any);
}

const brand = (over: any) => ({
  id: "b",
  name: "B",
  logoUrl: null,
  stripeConnectedAccountId: null,
  applicationFeeMode: "none",
  directOrderingEnabled: false,
  primaryLocationId: null,
  country: "GB",
  tapMerchantId: null,
  tapOnboardingStatus: "not_started",
  tapConnectUrl: null,
  locations: [],
  ...over,
});

describe("listBrandConnectStatus", () => {
  it("lists a Gulf brand as TAP from its kitchen's country, even without online ordering", async () => {
    const svc = build(
      [brand({ id: "dxb", primaryLocationId: "locDXB", country: "GB" })],
      [{ id: "locDXB", country: "AE" }],
    );
    const rows = await svc.listBrandConnectStatus("t1", "locDXB");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brandId: "dxb", country: "AE", provider: "TAP" });
  });

  it("still hides a UK brand that doesn't sell online, as before", async () => {
    const svc = build(
      [
        brand({ id: "uk-off", locations: [{ country: "GB" }] }),
        brand({ id: "uk-on", directOrderingEnabled: true, locations: [{ country: "GB" }] }),
      ],
      [],
    );
    const rows = await svc.listBrandConnectStatus("t1");
    expect(rows.map((r: any) => r.brandId)).toEqual(["uk-on"]);
    expect(rows[0].provider).toBe("STRIPE");
  });

  it("carries the Tap onboarding state for the row", async () => {
    const svc = build(
      [brand({ id: "dxb", primaryLocationId: "locDXB", tapMerchantId: "merchant_1", tapOnboardingStatus: "completed" })],
      [{ id: "locDXB", country: "AE" }],
    );
    const [row] = await svc.listBrandConnectStatus("t1");
    expect(row.tap).toEqual({ merchantId: "merchant_1", onboardingStatus: "completed", connectUrl: null });
  });
});
