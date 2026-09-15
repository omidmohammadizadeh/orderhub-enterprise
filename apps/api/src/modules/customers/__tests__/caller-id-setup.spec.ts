import { CallerIdSetupService, ownNumbersOf } from "../caller-id-setup.service";
import { CustomersController } from "../customers.controller";

// One shared platform key meant any provider holding it could post rings
// against any shop's location id. These tests pin the per-shop token that
// closes that, and the diagnostics that tell an operator whether the
// provider's test call actually arrived.

function svc(location: any = null) {
  const prisma: any = {
    location: {
      findFirst: jest.fn(async () => location),
      update: jest.fn(async ({ data }: any) => ({ ...location, ...data })),
    },
  };
  return { service: new CallerIdSetupService(prisma), prisma };
}

describe("CallerIdSetupService.authorise", () => {
  const SHOP = {
    id: "loc-1",
    phone: "01388 436844",
    settings: { voipWebhookToken: "ohcid_shopone" },
  };

  afterEach(() => {
    delete process.env.VOIP_WEBHOOK_KEY;
  });

  it("lets a shop's own token in", async () => {
    const { service } = svc(SHOP);
    await expect(service.authorise("loc-1", "ohcid_shopone")).resolves.toMatchObject({
      ok: true,
      via: "shop",
    });
  });

  it("refuses ANOTHER shop's token — the whole point of per-shop keys", async () => {
    const { service } = svc(SHOP);
    await expect(service.authorise("loc-1", "ohcid_shoptwo")).resolves.toMatchObject({
      ok: false,
    });
  });

  it("still accepts the platform key, so shops already live on it keep working", async () => {
    process.env.VOIP_WEBHOOK_KEY = "platform-secret";
    const { service } = svc(SHOP);
    await expect(service.authorise("loc-1", "platform-secret")).resolves.toMatchObject({
      ok: true,
      via: "shared",
    });
  });

  it("is never an open relay: no key set anywhere means nothing gets in", async () => {
    const { service } = svc({ id: "loc-1", phone: null, settings: {} });
    await expect(service.authorise("loc-1", "anything")).resolves.toMatchObject({ ok: false });
    await expect(service.authorise("loc-1", undefined)).resolves.toMatchObject({ ok: false });
  });

  it("reports whether the location exists, so a wrong key can still be logged for it", async () => {
    const { service } = svc(null);
    await expect(service.authorise("nope", "ohcid_x")).resolves.toMatchObject({
      ok: false,
      locationExists: false,
    });
  });
});

describe("CallerIdSetupService tokens", () => {
  it("mints a token scoped to the caller's own tenant", async () => {
    const { service, prisma } = svc({ id: "loc-1", name: "Shop", settings: { a: 1 } });
    const token = await service.rotateToken("tenant-1", "loc-1");
    expect(token).toMatch(/^ohcid_/);
    expect(prisma.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ brand: { tenantId: "tenant-1" } }),
      }),
    );
    // Existing settings survive — minting a token must not wipe opening hours.
    expect(prisma.location.update.mock.calls[0][0].data.settings).toMatchObject({
      a: 1,
      voipWebhookToken: token,
    });
  });

  it("refuses a location outside the tenant rather than returning its token", async () => {
    const { service } = svc(null);
    await expect(service.rotateToken("tenant-1", "someone-elses")).rejects.toThrow(
      /Unknown location/,
    );
  });

  it("never returns the platform key to a client — only the shop's own token", async () => {
    process.env.VOIP_WEBHOOK_KEY = "platform-secret";
    const { service } = svc({ id: "loc-1", name: "Shop", settings: {} });
    const setup = await service.getSetup("tenant-1", "loc-1");
    expect(JSON.stringify(setup)).not.toContain("platform-secret");
    expect(setup.token).toBeNull();
    expect(setup.sharedKeyEnabled).toBe(true);
    delete process.env.VOIP_WEBHOOK_KEY;
  });

  it("builds the address the provider is given from API_URL", async () => {
    const { service } = svc({ id: "loc-1", name: "Shop", settings: {} });
    process.env.API_URL = "https://orderhub-api-0re6.onrender.com";
    expect(service.webhookUrl("loc-1")).toBe(
      "https://orderhub-api-0re6.onrender.com/api/v1/customers/caller-id/voip/loc-1",
    );
    delete process.env.API_URL;
  });
});

describe("the did-it-arrive light", () => {
  it("keeps only the last 4 digits — a ring log is a log of customers' numbers", () => {
    const { service } = svc();
    service.record({ locationId: "loc-1", phone: "+447788187123", source: "webhook" });
    const [ring] = service.recentRings("loc-1");
    expect(ring.masked).toBe("…7123");
    expect(JSON.stringify(ring)).not.toContain("7788187");
    expect(ring.digits).toBe(12);
  });

  it("flags a ring carrying the SHOP's own number instead of the caller's", () => {
    const { service } = svc();
    const own = ownNumbersOf("01388 436844", { voiceNumber: "+441388436844" });
    service.record({ locationId: "loc-1", phone: "+441388436844", source: "webhook", ownNumbers: own });
    service.record({ locationId: "loc-1", phone: "07788187123", source: "webhook", ownNumbers: own });
    const rings = service.recentRings("loc-1");
    expect(rings[0].looksLikeShopsOwnNumber).toBe(false); // the caller
    expect(rings[1].looksLikeShopsOwnNumber).toBe(true); // the shop's own line
  });

  it("records a refused post, so 'wrong key' can't look like 'provider never called'", () => {
    const { service } = svc();
    service.record({ locationId: "loc-1", phone: "", source: "webhook", rejected: "wrong key" });
    expect(service.recentRings("loc-1")[0]).toMatchObject({
      rejected: "wrong key",
      masked: "(withheld)",
    });
  });

  it("keeps a bounded, newest-first window per shop", () => {
    const { service } = svc();
    for (let i = 0; i < 30; i++) {
      service.record({ locationId: "loc-1", phone: `0770000${String(i).padStart(4, "0")}`, source: "webhook" });
    }
    const rings = service.recentRings("loc-1");
    expect(rings.length).toBeLessThanOrEqual(12);
    expect(rings[0].masked).toBe("…0029");
  });
});

describe("POST /customers/caller-id/voip/:locationId", () => {
  function controller(over: { auth?: any; setup?: any; customers?: any } = {}) {
    const setup = {
      authorise: jest.fn(async () => over.auth ?? { ok: true, locationExists: true, ownNumbers: [] }),
      record: jest.fn(),
      ...over.setup,
    };
    const customers: any = {
      tenantForLocation: jest.fn(async () => "tenant-1"),
      lookupByPhone: jest.fn(async () => null),
      ...over.customers,
    };
    const socket: any = { emitToLocation: jest.fn() };
    return { c: new CustomersController(customers, socket, setup as any), setup, socket };
  }

  it("takes the key from the x-voip-key header, which is what we tell providers to use", async () => {
    const { c, setup, socket } = controller();
    await c.voipRing("loc-1", { From: "+447788187123" }, undefined, "ohcid_shopone");
    expect(setup.authorise).toHaveBeenCalledWith("loc-1", "ohcid_shopone");
    expect(socket.emitToLocation).toHaveBeenCalledWith(
      "loc-1",
      "callerid:ring",
      expect.objectContaining({ phone: "+447788187123" }),
    );
  });

  it("still accepts ?key= for providers that cannot send a header", async () => {
    const { c, setup } = controller();
    await c.voipRing("loc-1", { From: "+447788187123" }, "ohcid_shopone", undefined);
    expect(setup.authorise).toHaveBeenCalledWith("loc-1", "ohcid_shopone");
  });

  it("refuses a bad key and logs the attempt against the shop", async () => {
    const { c, setup, socket } = controller({ auth: { ok: false, locationExists: true, ownNumbers: [] } });
    await expect(
      c.voipRing("loc-1", { From: "+447788187123" }, undefined, "wrong"),
    ).rejects.toThrow(/Bad key/);
    expect(socket.emitToLocation).not.toHaveBeenCalled();
    expect(setup.record).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: "wrong key" }),
    );
  });

  it("does not log against a location that does not exist", async () => {
    const { c, setup } = controller({ auth: { ok: false, locationExists: false, ownNumbers: [] } });
    await expect(c.voipRing("nope", { From: "+447788187123" }, undefined, "x")).rejects.toThrow();
    expect(setup.record).not.toHaveBeenCalled();
  });

  it("records a payload with no caller number, which is its own diagnosis", async () => {
    const { c, setup } = controller();
    await expect(c.voipRing("loc-1", { event: "answered" }, undefined, "ohcid_shopone")).rejects.toThrow(
      /No caller number/,
    );
    expect(setup.record).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: expect.stringContaining("no caller number") }),
    );
  });
});
