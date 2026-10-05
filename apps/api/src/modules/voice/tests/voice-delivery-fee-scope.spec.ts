// The phone line charges the same delivery fee as online ordering.
//
// A zone can hang off the LOCATION or the BRAND. The line read the location's
// rows only, so a shop whose zones are on the brand had "no zones" on the
// phone and delivered free — the same £0 leak WhatsApp had the other way round
// (two orders on 2 Oct 2026). And a postcode no zone recognised priced at £0,
// where online checkout charges the highest configured fee.

import { VoiceContextService } from "../voice-context.service";
import { VoiceAiService } from "../voice-ai.service";

const contextSvc = (brandId: string | undefined) => {
  const wheres: any[] = [];
  const s: any = Object.create(VoiceContextService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.prisma = {
    deliveryZone: {
      findMany: async (q: any) => {
        wheres.push(q.where);
        return [{ id: "z", postcodePrefix: "NE33", fee: 3 }];
      },
    },
  };
  s.menus = {
    resolveContext: async () => ({
      tenantId: "t1",
      locationId: "loc1",
      brandId,
      brandName: "Pizza Uno",
      locationName: "Site",
      currency: "GBP",
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
    }),
  };
  s.locationForNumber = async () => ({
    id: "loc1",
    settings: { voiceAiEnabled: true },
    address: {},
    directOrderingConfig: {},
  });
  return { s, wheres };
};

describe("which zones the phone line prices from", () => {
  it("reads brand zones as well as location zones, like online checkout", async () => {
    const { s, wheres } = contextSvc("brand1");
    const ctx = await s.resolve("+441910000000");
    expect(ctx.deliveryZones).toHaveLength(1);
    expect(wheres[0].isActive).toBe(true);
    expect(wheres[0].OR).toEqual(
      expect.arrayContaining([{ locationId: "loc1" }, { brandId: "brand1" }]),
    );
  });

  it("still reads the location's zones when no brand resolved", async () => {
    const { s, wheres } = contextSvc(undefined);
    await s.resolve("+441910000000");
    expect(wheres[0].OR).toEqual(expect.arrayContaining([{ locationId: "loc1" }]));
  });
});

describe("feeForAddress", () => {
  const ai: any = Object.create(VoiceAiService.prototype);
  const ctx = (zones: any[]) => ({ currency: "GBP", deliveryZones: zones }) as any;
  const pc = (fee: number, prefix: string) => ({
    id: prefix,
    postcodePrefix: prefix,
    areaName: null,
    maxDistanceMiles: null,
    fee,
    minOrderValue: null,
  });

  it("charges the matching zone's fee", () => {
    expect(ai.feeForAddress({ postcode: "NE33 2AB" }, ctx([pc(3, "NE33"), pc(4.5, "NE34")]))).toBe(3);
  });

  it("charges the highest fee for a postcode no zone knows, never £0", () => {
    expect(ai.feeForAddress({ postcode: "NE99 9ZZ" }, ctx([pc(3, "NE33"), pc(4.5, "NE34")]))).toBe(4.5);
  });

  it("does not price an unlisted area", () => {
    const area = { ...pc(15, ""), postcodePrefix: null, areaName: "Dubai Marina" };
    expect(ai.feeForAddress({ area: "Al Quoz" }, ctx([area]))).toBe(0);
  });

  it("is zero when the shop has no zones at all", () => {
    expect(ai.feeForAddress({ postcode: "NE33 2AB" }, ctx([]))).toBe(0);
  });
});

describe("checkArea for a postcode no zone knows", () => {
  const ai: any = Object.create(VoiceAiService.prototype);
  const zones = [
    { id: "a", postcodePrefix: "NE33", areaName: null, maxDistanceMiles: null, fee: 3, minOrderValue: null },
    { id: "b", postcodePrefix: "NE34", areaName: null, maxDistanceMiles: null, fee: 4.5, minOrderValue: null },
  ];
  const ctx = { currency: "GBP", deliveryZones: zones } as any;

  it("takes it at the highest fee, like online ordering", () => {
    const out = ai.checkArea("NE36 1AA", ctx);
    expect(out).not.toContain("does NOT deliver");
    expect(out).toContain("£4.50");
  });

  it("still quotes the matching zone when there is one", () => {
    expect(ai.checkArea("NE33 2AB", ctx)).toContain("£3.00");
  });
});
