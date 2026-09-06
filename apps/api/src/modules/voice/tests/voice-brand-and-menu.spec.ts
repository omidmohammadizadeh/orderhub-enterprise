// Which shop the AI says it is, and whose menu it reads from.
//
// One kitchen can trade under several brands from one phone number, and
// nothing about the location row says which of them a caller who dialled that
// number expects to hear. It is an operator's decision, so it is a setting —
// and it has to carry all the way through: the greeting, the prices, and the
// brand the finished order lands under.

import { VoiceContextService } from "../voice-context.service";
import { VoiceAiService } from "../voice-ai.service";

const svc = (opts: {
  settings?: Record<string, unknown>;
  menuCtx?: Record<string, unknown> | null;
}) => {
  const calls: any[] = [];
  const s: any = Object.create(VoiceContextService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.prisma = {
    deliveryZone: { findMany: async () => [] },
    location: { findFirst: async () => null, findMany: async () => [] },
  };
  s.menus = {
    resolveContext: async (_id: any, o: any) => {
      calls.push(o);
      return opts.menuCtx === undefined
        ? {
            tenantId: "t1",
            locationId: "loc1",
            brandId: o.brandIdOverride ?? "brand-location",
            brandName: o.brandIdOverride ? "Kingston Pizza" : "Pizza Uno Brand",
            locationName: "Pelton Site",
            currency: "GBP",
            items: [],
            itemIndex: new Map(),
            optionIndex: new Map(),
          }
        : opts.menuCtx;
    },
  };
  s.locationForNumber = async () => ({
    id: "loc1",
    phone: "0191 000 0000",
    settings: { voiceAiEnabled: true, ...(opts.settings ?? {}) },
    address: {},
    timezone: "Europe/London",
    openingHours: null,
    directOrderingConfig: {},
  });
  return { s, calls };
};

describe("whose menu the phone reads from", () => {
  it("is the POS menu, always", async () => {
    // A phone order is taken by somebody standing at the till in every way
    // that matters — same prices, same choices, same 86'd items. Resolving a
    // separate PHONE menu meant publishing to a channel nobody thinks about,
    // and when that was never done the line fell through to whatever menu
    // happened to be active: food the till would not sell.
    const { s, calls } = svc({});
    await s.resolve("+441910000000");

    expect(calls[0].channel).toBe("POS");
    expect(calls[0].locationIdOverride).toBe("loc1");
  });

  it("reads the chosen brand's menu when one is set", async () => {
    const { s, calls } = svc({ settings: { voiceBrandId: "brand-kingston" } });
    const ctx = await s.resolve("+441910000000");

    expect(calls[0].brandIdOverride).toBe("brand-kingston");
    // And the order will land under that brand, not the location's own.
    expect(ctx.brandId).toBe("brand-kingston");
  });

  it("asks for no brand in particular when none is chosen", async () => {
    const { s, calls } = svc({});
    expect(calls.length).toBe(0);
    await s.resolve("+441910000000");
    expect(calls[0].brandIdOverride).toBeNull();
  });
});

describe("the name the caller hears", () => {
  it("is the brand's, not the site's", async () => {
    // "Pelton Site" is what the operator calls the kitchen. It is not what is
    // written above the door and not what the customer dialled.
    const { s } = svc({ settings: { voiceBrandId: "brand-kingston" } });
    const ctx = await s.resolve("+441910000000");

    expect(ctx.locationName).toBe("Kingston Pizza");

    const ai: any = Object.create(VoiceAiService.prototype);
    expect(ai.greeting(ctx, null)).toContain("welcome to Kingston Pizza.");
  });

  it("falls back to the location's own name when the brand has none", async () => {
    const { s } = svc({
      menuCtx: {
        tenantId: "t1",
        locationId: "loc1",
        locationName: "Pizza Uno",
        currency: "GBP",
        items: [],
        itemIndex: new Map(),
        optionIndex: new Map(),
      },
    });
    const ctx = await s.resolve("+441910000000");
    expect(ctx.locationName).toBe("Pizza Uno");
  });

  it("says so in the log when a chosen brand did not resolve", async () => {
    // A brand id that no longer exists must not silently answer as something
    // else — the caller would be greeted by the wrong shop and nothing would
    // say why.
    const { s } = svc({ settings: { voiceBrandId: "brand-deleted" } });
    const warn = jest.fn();
    s.logger = { log() {}, warn, error() {} };
    s.menus.resolveContext = async () => ({
      tenantId: "t1",
      locationId: "loc1",
      brandId: "brand-location",
      brandName: "Pizza Uno",
      locationName: "Pelton Site",
      currency: "GBP",
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
    });

    const ctx = await s.resolve("+441910000000");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("brand-deleted"));
    // Still answers — a call taken under the wrong name beats a call refused.
    expect(ctx.locationName).toBe("Pizza Uno");
  });
});

describe("a brand id is operator input, so it is checked", () => {
  const { WhatsAppMenuService } = require("../../whatsapp/whatsapp-menu.service");

  const menuSvc = (brandLookup: (where: any) => any) => {
    const s: any = Object.create(WhatsAppMenuService.prototype);
    s.logger = { log() {}, warn: jest.fn(), error() {} };
    s.menuAssignments = { resolveAssignedMenuId: async () => null };
    s.variantResolver = { forBrandChannel: async () => null };
    s.prisma = {
      location: {
        findUnique: async () => ({
          id: "loc1",
          brandId: "brand-mine",
          name: "Pelton Site",
          country: "GB",
          currency: "GBP",
          brand: { tenantId: "tenant-mine", name: "Pizza Uno" },
        }),
      },
      brand: { findFirst: async ({ where }: any) => brandLookup(where) },
      menu: { findFirst: async () => null },
    };
    return s;
  };

  it("refuses a brand belonging to somebody else's tenant", async () => {
    // Nothing about serving the wrong tenant's menu looks like a failure from
    // outside: the caller is simply read a different shop's food at a
    // different shop's prices.
    let asked: any = null;
    const s = menuSvc((where) => {
      asked = where;
      return null; // not on this tenant
    });
    await s.resolveContext(undefined, {
      locationIdOverride: "loc1",
      channel: "POS",
      brandIdOverride: "brand-someone-else",
    });

    expect(asked).toEqual({ id: "brand-someone-else", tenantId: "tenant-mine" });
    expect(s.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not on location loc1's tenant"),
    );
  });

  it("does not go looking when the chosen brand is the location's own", async () => {
    const lookup = jest.fn(() => null);
    const s = menuSvc(lookup as any);
    await s.resolveContext(undefined, {
      locationIdOverride: "loc1",
      brandIdOverride: "brand-mine",
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
