import { YangoConfigService, yangoCountrySupported } from "../yango-config.service";

type Row = Record<string, any>;

function svcWith(rows: Row[], loc: Row = {}, geo: any = null) {
  const location = {
    id: "loc1",
    name: "Shawarma House",
    country: "AE",
    addressLine1: "Al Wasl Road 12",
    city: "Dubai",
    ...loc,
  };
  const prisma: any = {
    location: { findFirst: jest.fn(async () => location) },
    yangoConfig: {
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.locationId === where.locationId) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.webhookToken === where.webhookToken) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const found = rows.find((r) => r.locationId === where.locationId);
        if (found) Object.assign(found, update);
        else rows.push({ ...create });
        return {};
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const found = rows.find((r) => r.locationId === where.locationId);
        if (found) Object.assign(found, data);
        return {};
      }),
    },
  };
  const encryption: any = { encrypt: (v: any) => ({ plain: v }), decrypt: (v: any) => v?.plain ?? {} };
  const geocoding: any = { geocode: jest.fn(async () => geo) };
  const s: any = Object.create(YangoConfigService.prototype);
  s.prisma = prisma;
  s.encryption = encryption;
  s.geocoding = geocoding;
  return { s: s as YangoConfigService, rows, geocoding };
}

const row = (over: Row = {}): Row => ({
  tenantId: "t1",
  locationId: "loc1",
  mode: "estimate_only",
  credentials: { plain: { token: "y0_AgAAAABCDEFGHIJKLMNOP" } },
  taxiClass: "courier",
  contactEmail: "ops@shop.ae",
  pickupLat: 25.2,
  pickupLng: 55.27,
  webhookToken: "wh-token",
  active: true,
  ...over,
});

describe("UAE only", () => {
  it("recognises the UAE however the country was typed", () => {
    expect(yangoCountrySupported("AE")).toBe(true);
    expect(yangoCountrySupported("GB")).toBe(false);
    expect(yangoCountrySupported(null)).toBe(false);
  });

  it("refuses to set Yango up for a UK shop", async () => {
    const { s, rows } = svcWith([], { country: "GB" });
    await expect(s.upsert("loc1", "t1", { token: "abc" })).rejects.toThrow(/only available for shops in the UAE/);
    expect(rows).toHaveLength(0);
  });

  it("says so in the public config, so the dashboard can hide it", async () => {
    const { s } = svcWith([], { country: "GB" });
    const pub = await s.getPublicConfig("loc1", "t1", "https://api.x");
    expect(pub.countrySupported).toBe(false);
  });
});

describe("estimate-only by default — Yango has no sandbox", () => {
  it("a new config starts in estimate_only", async () => {
    const { s, rows } = svcWith([], {}, { lat: 25.2, lng: 55.27 });
    const r = await s.upsert("loc1", "t1", { token: "abc", contactEmail: "a@b.ae" });
    expect(r.mode).toBe("estimate_only");
    expect(rows[0]!.mode).toBe("estimate_only");
  });

  it("switching to live needs an explicit acknowledgement", async () => {
    const { s, rows } = svcWith([row()]);
    await expect(s.upsert("loc1", "t1", { mode: "live" })).rejects.toThrow(/real Yango courier/);
    expect(rows[0]!.mode).toBe("estimate_only");
    await s.upsert("loc1", "t1", { mode: "live", acknowledgeLiveCouriers: true });
    expect(rows[0]!.mode).toBe("live");
  });

  it("re-saving other settings while live does not need the acknowledgement again", async () => {
    const { s, rows } = svcWith([row({ mode: "live" })]);
    await s.upsert("loc1", "t1", { taxiClass: "express" });
    expect(rows[0]!.mode).toBe("live");
    expect(rows[0]!.taxiClass).toBe("express");
  });

  it("readyToDispatch only in live; canQuote in both", async () => {
    const { s } = svcWith([row()]);
    const pub = await s.getPublicConfig("loc1", "t1", "https://api.x");
    expect(pub.canQuote).toBe(true);
    expect(pub.readyToDispatch).toBe(false);
  });
});

describe("token", () => {
  it("is never returned, only masked", async () => {
    const { s } = svcWith([row()]);
    const pub: any = await s.getPublicConfig("loc1", "t1", "https://api.x");
    expect(JSON.stringify(pub)).not.toContain("y0_AgAAAABCDEFGHIJKLMNOP");
    expect(pub.tokenMasked).toBe("y0_A…MNOP");
  });

  it("a blank token on re-save keeps the stored one", async () => {
    const { s, rows } = svcWith([row()]);
    await s.upsert("loc1", "t1", { token: "", taxiClass: "express" });
    expect(rows[0]!.credentials.plain.token).toBe("y0_AgAAAABCDEFGHIJKLMNOP");
  });

  it("rejects a wrapped/mangled paste", async () => {
    const { s } = svcWith([]);
    await expect(s.upsert("loc1", "t1", { token: "abc def" })).rejects.toThrow(/spaces/);
  });

  it("requires a token the first time", async () => {
    const { s } = svcWith([]);
    await expect(s.upsert("loc1", "t1", {})).rejects.toThrow(/Integration/);
  });
});

describe("pickup point", () => {
  it("is geocoded from the shop address once, in the UAE", async () => {
    const { s, rows, geocoding } = svcWith([], {}, { lat: 25.1972, lng: 55.2396 });
    const r = await s.upsert("loc1", "t1", { token: "abc" });
    expect(geocoding.geocode).toHaveBeenCalledWith("Al Wasl Road 12, Dubai", "AE");
    expect(r.geocodedPickup).toBe(true);
    expect([rows[0]!.pickupLat, rows[0]!.pickupLng]).toEqual([25.1972, 55.2396]);
  });

  it("is not re-geocoded when one is stored", async () => {
    const { s, geocoding } = svcWith([row()]);
    await s.upsert("loc1", "t1", {});
    expect(geocoding.geocode).not.toHaveBeenCalled();
  });

  it("can be corrected by hand, and nonsense is refused", async () => {
    const { s, rows } = svcWith([row()]);
    await s.upsert("loc1", "t1", { pickupLat: 25.11, pickupLng: 55.22 });
    expect([rows[0]!.pickupLat, rows[0]!.pickupLng]).toEqual([25.11, 55.22]);
    await expect(s.upsert("loc1", "t1", { pickupLat: 0, pickupLng: 0 })).rejects.toThrow(/aren't valid/);
    await expect(s.upsert("loc1", "t1", { pickupLat: 125, pickupLng: 55 })).rejects.toThrow(/aren't valid/);
  });

  it("activation is blocked without a pickup point or a contact email", async () => {
    const a = svcWith([row({ pickupLat: null, pickupLng: null })]);
    await expect(a.s.setActive("loc1", "t1", true)).rejects.toThrow(/pickup point/);
    const b = svcWith([row({ contactEmail: null })]);
    await expect(b.s.setActive("loc1", "t1", true)).rejects.toThrow(/contact email/);
    const c = svcWith([row()]);
    await expect(c.s.setActive("loc1", "t1", true)).resolves.toEqual({ ok: true, active: true });
  });

  it("deactivating always works, even outside the UAE", async () => {
    const { s } = svcWith([row()], { country: "GB" });
    await expect(s.setActive("loc1", "t1", false)).resolves.toEqual({ ok: true, active: false });
  });
});

describe("callback URL", () => {
  it("ends in '?' — Yango CONCATENATES updated_ts=…&claim_id=… onto it", async () => {
    const { s } = svcWith([row()]);
    const pub = await s.getPublicConfig("loc1", "t1", "https://api.x/");
    expect(pub.webhookUrl).toBe("https://api.x/api/v1/webhooks/yango/wh-token?");
    expect(`${pub.webhookUrl}updated_ts=1&claim_id=abc`).toBe(
      "https://api.x/api/v1/webhooks/yango/wh-token?updated_ts=1&claim_id=abc",
    );
  });
});
