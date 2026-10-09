import { PaymentsService } from "../payments.service";

// Clifton (SMASHING BURGER) had no Stripe account, yet its QR payments landed
// on JINTY'S (2026-10-09). JINTY'S onboarded per brand, which writes a row with
// brandId set and locationId null — and the "tenant-level" fallback only asked
// for locationId null, so it handed JINTY'S account to every shop without one.

type Row = {
  id: string;
  tenantId: string;
  locationId: string | null;
  brandId: string | null;
  stripeAccountId: string;
  chargesEnabled: boolean;
};

function build(rows: Row[], brandAcct: Record<string, string | null> = {}) {
  const matches = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  const prisma: any = {
    brand: {
      findUnique: async ({ where }: any) => ({
        stripeConnectedAccountId: brandAcct[where.id] ?? null,
      }),
    },
    location: { findUnique: async () => ({ stripeConnectedAccountId: null }) },
    stripeConnectAccount: {
      findFirst: async ({ where }: any) =>
        rows.find((r) => matches(r, where)) ?? null,
    },
  };
  const config: any = { get: () => undefined };
  return new PaymentsService(prisma, {} as any, config, {} as any, {} as any, {} as any);
}

const jinty: Row = {
  id: "row-jinty",
  tenantId: "t1",
  locationId: null,
  brandId: "brand-jinty",
  stripeAccountId: "acct_JINTY",
  chargesEnabled: true,
};

describe("resolveConnectAccount scope", () => {
  it("never pays another brand's account to a shop that has none", async () => {
    const svc = build([jinty], { "brand-jinty": "acct_JINTY" });
    await expect(
      svc.resolveConnectAccount("t1", "loc-clifton", "brand-smashing"),
    ).resolves.toBeNull();
  });

  it("still uses a genuine tenant-level account", async () => {
    const tenantRow: Row = { ...jinty, id: "row-t", brandId: null, stripeAccountId: "acct_TENANT" };
    const svc = build([jinty, tenantRow]);
    await expect(
      svc.resolveConnectAccount("t1", "loc-clifton", "brand-smashing"),
    ).resolves.toEqual({ id: "row-t", stripeAccountId: "acct_TENANT" });
  });

  it("still pays JINTY'S own orders into JINTY'S account", async () => {
    const svc = build([jinty], { "brand-jinty": "acct_JINTY" });
    await expect(
      svc.resolveConnectAccount("t1", "loc-any", "brand-jinty"),
    ).resolves.toEqual({ id: null, stripeAccountId: "acct_JINTY" });
  });
});
