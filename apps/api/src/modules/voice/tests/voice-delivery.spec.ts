import { VoiceAiService } from "../voice-ai.service";

// The phone agent against the three delivery-zone modes.
//
// VoiceContext used to flatten every zone to
// `postcodePrefix: String(z.postcodePrefix ?? "")`, so an area or distance row
// arrived as an EMPTY prefix — and "".startsWith() is true for every postcode,
// so the bot cheerfully quoted whichever row it happened to hit first. It now
// carries the real rows and runs the shared resolver.
//
// Private methods reached through the prototype: the service's constructor
// pulls in Anthropic and the orders pipeline, none of which this touches.

const svc = () => Object.create(VoiceAiService.prototype) as any;

const ctx = (zones: any[], over: Record<string, unknown> = {}) =>
  ({
    deliveryZones: zones.map((z) => ({
      postcodePrefix: null,
      areaName: null,
      maxDistanceMiles: null,
      minOrderValue: null,
      ...z,
    })),
    country: "GB",
    currency: "GBP",
    ...over,
  }) as any;

describe("checkArea", () => {
  it("quotes an area the shop serves, in the shop's currency", () => {
    const out = svc().checkArea(
      "Dubai Marina",
      ctx([{ id: "m", areaName: "Dubai Marina", fee: 15, minOrderValue: 40 }], {
        country: "AE",
        currency: "AED",
      }),
    );
    expect(out).toContain("Delivers to Dubai Marina");
    expect(out).toContain("AED 15.00");
    expect(out).toContain("minimum order AED 40.00");
  });

  it("matches an area across the Arabic article", () => {
    const out = svc().checkArea(
      "Barsha",
      ctx([{ id: "b", areaName: "Al Barsha", fee: 18 }], { country: "AE", currency: "AED" }),
    );
    expect(out).toContain("Delivers to Al Barsha");
  });

  it("tells the caller plainly when the shop does not go there", () => {
    const out = svc().checkArea(
      "Al Quoz",
      ctx([{ id: "m", areaName: "Dubai Marina", fee: 15 }], { country: "AE" }),
    );
    expect(out).toContain("does NOT deliver to Al Quoz");
    expect(out).toContain("collection");
  });

  it("asks for the right thing when nothing was given", () => {
    expect(svc().checkArea("", ctx([{ id: "m", areaName: "Marina", fee: 15 }]))).toMatch(
      /which area/i,
    );
    expect(svc().checkArea("", ctx([{ id: "p", postcodePrefix: "SW1", fee: 3 }]))).toMatch(
      /postcode/i,
    );
  });

  it("still does longest-prefix postcodes for a UK shop", () => {
    const out = svc().checkArea(
      "SW1A 1AA",
      ctx([
        { id: "broad", postcodePrefix: "SW1", fee: 3.5 },
        { id: "narrow", postcodePrefix: "SW1A", fee: 2 },
      ]),
    );
    expect(out).toContain("£2.00");
  });

  it("does not let an area row match every postcode", () => {
    // The exact old bug: areaName rows arrived with prefix "" and matched
    // anything, so a shop with one area zone quoted it to every caller.
    const out = svc().checkArea(
      "NE10 8YH",
      ctx([{ id: "m", areaName: "Dubai Marina", fee: 15 }]),
    );
    expect(out).toContain("does NOT deliver");
  });
});

describe("feeForAddress", () => {
  it("prices by the area the caller gave", () => {
    expect(
      svc().feeForAddress(
        { area: "JLT" },
        ctx([
          { id: "m", areaName: "Dubai Marina", fee: 15 },
          { id: "j", areaName: "JLT", fee: 12 },
        ]),
      ),
    ).toBe(12);
  });

  it("charges nothing extra for an area the shop does not serve", () => {
    // The order can't be placed at all in that case — place_order refuses
    // without a located address — so a zero here is the absence of a quote,
    // not a free delivery.
    expect(
      svc().feeForAddress(
        { area: "Al Quoz" },
        ctx([{ id: "m", areaName: "Dubai Marina", fee: 15 }]),
      ),
    ).toBe(0);
  });

  it("quotes the top distance band, since a phone call has no coordinates", () => {
    expect(
      svc().feeForAddress(
        { postcode: "NE10 8YH" },
        ctx([
          { id: "near", maxDistanceMiles: 2, fee: 2 },
          { id: "far", maxDistanceMiles: 5, fee: 6 },
        ]),
      ),
    ).toBe(6);
  });
});
