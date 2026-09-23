// AI Studio spends real money from a LOCATION's wallet.
//
// Two properties matter more than the arithmetic:
//
//   1. One location can never spend another's balance. A shop with two sites
//      funds them separately; a manager at one site must not be able to burn
//      the other site's money, or the tenant-wide wallet, by passing a
//      different locationId to the generate call.
//
//   2. Money taken is money given back. If the provider refuses the render the
//      charge is reversed, and the reversal is for what was ACTUALLY taken —
//      not what the price list says today, which can differ.

import { VideoStudioService } from "../video-studio.service";

const USER = { tenantId: "t1", userId: "u1", role: "OWNER" } as any;

function makeService(opts: { balanceMinor?: number; createFails?: boolean } = {}) {
  const calls: any = { debits: [], refunds: [], accessChecks: [], created: [], deleted: [] };
  const svc = Object.create(VideoStudioService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.gemini = { isConfigured: () => true, model: "veo-3.1-lite-generate-preview", durationSeconds: 8 };
  svc.replicate = { isConfigured: () => true, model: "wan-video/wan-2.2-i2v-fast" };
  svc.storage = { isConfigured: () => true };

  svc.wallet = {
    assertLocationAccess: jest.fn(async (tenantId: string, locationId: string | null, userId: string, role: string) => {
      calls.accessChecks.push({ tenantId, locationId, userId, role });
      // Stand-in for the real rule: this user owns loc-A only.
      if (role !== "PLATFORM_ADMIN" && locationId !== "loc-A") {
        throw new Error("You don't have access to this location's wallet.");
      }
    }),
    getOrCreate: async (_t: string, locationId: string | null) => ({
      id: `w-${locationId}`,
      balanceMinor: opts.balanceMinor ?? 1000,
      currency: "GBP",
    }),
    aiStudioPriceMinor: (_w: any, styleId: string) =>
      ({ spokesperson: 150, cinematic: 50, "product-photo": 20 })[styleId] ?? 50,
    debitForAiStudio: jest.fn(async (args: any) => {
      calls.debits.push(args);
      return { chargedMinor: args.amountMinor, balanceAfterMinor: 0 };
    }),
    refundAiStudio: jest.fn(async (args: any) => calls.refunds.push(args)),
  };

  svc.prisma = {
    videoStudioAccount: {
      findUnique: async () => ({ tenantId: "t1", addonActive: true }),
    },
    videoGeneration: {
      create: async ({ data }: any) => {
        calls.created.push(data);
        return { id: "gen-1", ...data };
      },
      update: async (a: any) => a,
      delete: async (a: any) => {
        calls.deleted.push(a);
        return a;
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const refuse = () => {
    if (opts.createFails) throw new Error("provider said no");
  };
  svc.gemini.createOperation = jest.fn(async () => (refuse(), { id: "op-1" }));
  svc.replicate.createPrediction = jest.fn(async () => (refuse(), { id: "pred-1" }));
  return { svc, calls };
}

const dto = (over: any = {}) => ({
  prompt: "A close-up of a margherita pizza",
  script: "Fresh from our oven tonight",
  style: "spokesperson",
  imageUrl: "https://example.com/pizza.jpg",
  locationId: "loc-A",
  ...over,
});

describe("AI Studio — billing the location's wallet", () => {
  it("charges the selected location's wallet at that style's price", async () => {
    const { svc, calls } = makeService();
    await svc.generate(USER, dto());
    expect(calls.debits).toHaveLength(1);
    expect(calls.debits[0]).toMatchObject({ locationId: "loc-A", amountMinor: 150 });
    // And the row records what was taken, so a later refund can't drift.
    expect(calls.created[0]).toMatchObject({ locationId: "loc-A", chargedMinor: 150 });
  });

  it("refuses to spend another location's balance", async () => {
    const { svc, calls } = makeService();
    await expect(svc.generate(USER, dto({ locationId: "loc-B" }))).rejects.toThrow(/access/i);
    // Nothing was charged and no row was written — the check happens before
    // either, so a rejected attempt leaves no trace to clean up.
    expect(calls.debits).toHaveLength(0);
    expect(calls.created).toHaveLength(0);
  });

  it("refuses the tenant-wide wallet to a location-scoped user", async () => {
    const { svc, calls } = makeService();
    await expect(svc.generate(USER, dto({ locationId: undefined }))).rejects.toThrow(/access/i);
    expect(calls.accessChecks[0]).toMatchObject({ locationId: null });
    expect(calls.debits).toHaveLength(0);
  });

  it("prices each style separately", async () => {
    for (const [style, expected] of [["cinematic", 50], ["product-photo", 20]] as const) {
      const { svc, calls } = makeService();
      await svc.generate(USER, dto({ style }));
      expect(calls.debits[0].amountMinor).toBe(expected);
    }
  });

  it("gives the money back when the provider won't start the render", async () => {
    const { svc, calls } = makeService({ createFails: true });
    await expect(svc.generate(USER, dto())).rejects.toThrow();
    expect(calls.refunds).toHaveLength(1);
    expect(calls.refunds[0]).toMatchObject({ locationId: "loc-A", amountMinor: 150 });
  });

  it("refunds what was actually taken, not today's price", async () => {
    const { svc, calls } = makeService();
    // A render charged 150p back when it started; the price list has since
    // changed. The refund must follow the row, not the list.
    svc.wallet.aiStudioPriceMinor = () => 999;
    await svc.failAndRefund(
      { id: "gen-old", tenantId: "t1", locationId: "loc-A", chargedMinor: 150 },
      "render failed",
    );
    expect(calls.refunds[0]).toMatchObject({ amountMinor: 150 });
  });

  it("refunds nothing for a pre-wallet row that never took money", async () => {
    const { svc, calls } = makeService();
    await svc.failAndRefund(
      { id: "gen-legacy", tenantId: "t1", locationId: null, chargedMinor: null },
      "render failed",
    );
    expect(calls.refunds[0]).toMatchObject({ amountMinor: 0 });
  });
});
