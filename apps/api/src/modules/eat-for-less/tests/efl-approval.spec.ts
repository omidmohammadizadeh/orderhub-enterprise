import { EflService } from "../efl.service";

// Our commission rides Stripe's application fee. A shop we approve must be
// payable through Stripe, or its orders would carry no commission (Tap,
// Mollie) or couldn't be paid at all (no Stripe account).

function setup(opts: { country?: string; mollie?: boolean; stripe?: boolean }) {
  const update = jest.fn(async () => ({}));
  const prisma: any = {
    eflListing: {
      findUnique: jest.fn(async () => ({ id: "lst_1", locationId: "loc_1", brandId: null, approvedAt: null })),
      update,
      findMany: jest.fn(async () => []),
    },
    eflConfig: { findUnique: jest.fn(async () => null) },
    location: {
      findUnique: jest.fn(async () => ({
        id: "loc_1",
        country: opts.country ?? "GB",
        brandId: "brand_1",
        brand: { tenantId: "t_1" },
      })),
    },
  };
  const payments: any = { resolveConnectAccount: jest.fn(async () => (opts.stripe === false ? null : { stripeAccountId: "acct_1" })) };
  const mollie: any = { activeConnectionForBrand: jest.fn(async () => (opts.mollie ? { id: "m" } : null)) };
  const service = new EflService(prisma, {} as any, {} as any, {} as any, payments, mollie);
  return { service, update };
}

describe("EflService.adminUpdateListing approval", () => {
  it("approves a Stripe shop", async () => {
    const { service, update } = setup({});
    await service.adminUpdateListing("lst_1", { status: "APPROVED" });
    expect(update).toHaveBeenCalled();
  });

  it("refuses a Mollie brand", async () => {
    const { service, update } = setup({ mollie: true });
    await expect(service.adminUpdateListing("lst_1", { status: "APPROVED" })).rejects.toThrow(/Mollie/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a Tap country", async () => {
    const { service } = setup({ country: "AE" });
    await expect(service.adminUpdateListing("lst_1", { status: "APPROVED" })).rejects.toThrow(/Tap/);
  });

  it("refuses a shop with no Stripe account", async () => {
    const { service } = setup({ stripe: false });
    await expect(service.adminUpdateListing("lst_1", { status: "APPROVED" })).rejects.toThrow(/connected Stripe/);
  });

  it("doesn't check payments for a commission-only change", async () => {
    const { service, update } = setup({ mollie: true });
    await service.adminUpdateListing("lst_1", { commissionPercent: 6 });
    expect(update).toHaveBeenCalled();
  });
});
