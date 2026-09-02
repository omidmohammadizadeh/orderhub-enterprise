import { OrdersService } from "../orders.service";

// A simulated marketplace order has to be dressed as the real thing, because
// everything downstream keys off these fields: the board's channel badge, the
// receipt-QR decision, station routing and reporting.
//
// The trap this pins: platform, orderSource and integrationSource are THREE
// DIFFERENT ENUMS. IntegrationSource is only DIRECT | HUBRISE — it records how
// an order reached us, not who sent it — so setting it to "DELIVEROO" is not
// merely wrong, Prisma rejects it and the request 500s. It did, on every
// simulate, until this was fixed.

function makeService() {
  const svc: any = Object.create(OrdersService.prototype);
  svc.prisma = {
    location: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: "loc-1", brandId: "b-1", name: "Test Shop" }),
    },
  };
  svc.audit = { log: jest.fn() };
  svc.ingestCanonical = jest.fn().mockResolvedValue({ id: "o-1" });
  return svc as OrdersService & any;
}

const canonicalFrom = (svc: any) => svc.ingestCanonical.mock.calls[0][0];

describe("createTest — simulated marketplace orders", () => {
  it.each(["DELIVEROO", "UBER_EATS", "JUST_EAT"] as const)(
    "dresses a %s order as that marketplace",
    async (platform) => {
      const svc = makeService();
      await svc.createTest("t1", "loc-1", "u1", { platform });
      const c = canonicalFrom(svc);
      expect(c.platform).toBe(platform);
      expect(c.orderSource).toBe(platform);
    },
  );

  it("keeps integrationSource DIRECT — it is not the marketplace name", () => {
    // The whole bug in one assertion. IntegrationSource has two values and
    // neither of them is a marketplace.
    const svc = makeService();
    return svc
      .createTest("t1", "loc-1", "u1", { platform: "DELIVEROO" })
      .then(() => {
        const c = canonicalFrom(svc);
        expect(c.integrationSource).toBe("DIRECT");
        expect(["DIRECT", "HUBRISE"]).toContain(c.integrationSource);
        expect(c.viaHubrise).toBe(false);
      });
  });

  it("marks it SIM and says which marketplace it is pretending to be", async () => {
    const svc = makeService();
    await svc.createTest("t1", "loc-1", "u1", { platform: "JUST_EAT" });
    const c = canonicalFrom(svc);
    expect(c.displayId).toMatch(/^SIM-/);
    expect(c.specialInstructions).toContain("JUST_EAT");
    expect(c.metadata.simulatedPlatform).toBe("JUST_EAT");
  });

  it("leaves the ordinary test order exactly as it was", async () => {
    // Operators use this one to check printer and board wiring. It must stay
    // DIRECT/POS, or it would start printing a marketing QR at the till.
    const svc = makeService();
    await svc.createTest("t1", "loc-1", "u1", {});
    const c = canonicalFrom(svc);
    expect(c.platform).toBe("DIRECT");
    expect(c.orderSource).toBe("POS");
    expect(c.integrationSource).toBe("DIRECT");
    expect(c.displayId).toMatch(/^TEST-/);
    expect(c.metadata.simulatedPlatform).toBeUndefined();
  });
});
