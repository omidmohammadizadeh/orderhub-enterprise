import { MarketingService } from "../marketing.service";

// Which audience a storefront customer falls into decides whether they see a
// campaign discount at checkout — and CampaignRedemption attribution is
// written off the back of it.
//
// It has been throwing on every online order by a signed-in customer:
//
//   Campaign re-resolution failed: Unknown argument `tenantId`.
//   Available options are marked with ?.
//
// CustomerAccount has neither `tenantId` nor `totalOrders` — an account is
// global, and its only link to a tenant is through its orders. Checkout
// catches the throw so nothing breaks visibly, which is exactly why it went
// unnoticed: every returning customer has silently been treated as whatever
// the client already applied, and no campaign has been attributed.
//
// Scope still has to hold: one tenant's order history must never decide
// another tenant's audience.

function makeService(orders: Array<{ createdAt: Date }>, capture?: any[]) {
  const prisma = {
    order: {
      findFirst: jest.fn(async (args: any) => {
        capture?.push(args);
        return orders[0] ?? null;
      }),
    },
    customerAccount: {
      findFirst: jest.fn(async () => {
        throw new Error(
          "customerAccount.findFirst must not be called — the model has no tenantId",
        );
      }),
    },
  } as any;
  const svc = Object.create(MarketingService.prototype) as MarketingService;
  (svc as unknown as { prisma: unknown }).prisma = prisma;
  return svc;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("MarketingService.resolveAudience", () => {
  it("treats a signed-out visitor as NEW without touching the database", async () => {
    const svc = makeService([]);
    await expect(
      svc.resolveAudience({ tenantId: "t1", customerAccountId: null }),
    ).resolves.toBe("NEW");
  });

  it("treats an account with no orders at this tenant as NEW", async () => {
    const svc = makeService([]);
    await expect(
      svc.resolveAudience({ tenantId: "t1", customerAccountId: "c1" }),
    ).resolves.toBe("NEW");
  });

  it("treats a recent customer as RETURNING", async () => {
    const svc = makeService([{ createdAt: daysAgo(3) }]);
    await expect(
      svc.resolveAudience({ tenantId: "t1", customerAccountId: "c1" }),
    ).resolves.toBe("RETURNING");
  });

  it("treats a customer last seen over 45 days ago as LAPSED", async () => {
    const svc = makeService([{ createdAt: daysAgo(60) }]);
    await expect(
      svc.resolveAudience({ tenantId: "t1", customerAccountId: "c1" }),
    ).resolves.toBe("LAPSED");
  });

  it("scopes the history to this tenant and this customer", async () => {
    const calls: any[] = [];
    const svc = makeService([{ createdAt: daysAgo(3) }], calls);
    await svc.resolveAudience({ tenantId: "t1", customerAccountId: "c1" });

    expect(calls[0].where).toMatchObject({
      tenantId: "t1",
      customerAccountId: "c1",
    });
  });
});
