import { WhatsAppAiService } from "../whatsapp-ai.service";

// WhatsApp ordering against the three delivery-zone modes.
//
// The bot had its own private copy of longest-prefix postcode matching, which
// knew nothing about areas or distance bands. On a Gulf shop that meant every
// customer was told their address was outside the delivery zones — the bot
// asked for a postcode they don't have, matched it against nothing, and
// refused the order. It now runs the same shared resolver as the storefront.
//
// Private methods reached through the prototype, matching flow-multiselect
// here: the service's constructor pulls in Anthropic, Stripe and the whole
// orders pipeline, none of which this logic touches.

type Zone = {
  id: string;
  postcodePrefix?: string | null;
  areaName?: string | null;
  maxDistanceMiles?: number | null;
  fee: number;
  minOrderValue?: number | null;
};

const makeService = (zones: Zone[]) => {
  const sent: Array<{ kind: "text" | "list"; body: string; rows?: string[] }> = [];
  const svc = Object.create(WhatsAppAiService.prototype) as any;
  svc.prisma = {
    deliveryZone: {
      findMany: jest.fn().mockResolvedValue(
        zones.map((z) => ({
          postcodePrefix: null,
          areaName: null,
          maxDistanceMiles: null,
          minOrderValue: null,
          ...z,
        })),
      ),
    },
  };
  svc.send = {
    sendText: jest.fn(async (_p: string, _t: string, body: string) => {
      sent.push({ kind: "text", body });
    }),
    sendList: jest.fn(
      async (_p: string, _t: string, body: string, _b: string, sections: any[]) => {
        sent.push({
          kind: "list",
          body,
          rows: sections.flatMap((s) => s.rows.map((r: any) => r.title)),
        });
      },
    ),
  };
  return { svc, sent };
};

const ctx = (over: Partial<Record<string, unknown>> = {}) =>
  ({ brandId: "b1", country: "GB", currency: "GBP", ...over }) as any;

describe("askLocatingField", () => {
  it("asks for a postcode at a UK shop on postcode zones", async () => {
    const { svc, sent } = makeService([{ id: "p", postcodePrefix: "SW1", fee: 3 }]);
    const next = await svc.askLocatingField("pn", "447700900000", ctx());
    expect(next).toBe("ASK_POSTCODE");
    expect(sent[0]?.body).toMatch(/postcode/i);
  });

  it("asks which area at a shop that prices by area", async () => {
    const { svc, sent } = makeService([
      { id: "marina", areaName: "Dubai Marina", fee: 15 },
      { id: "jlt", areaName: "JLT", fee: 12 },
    ]);
    const next = await svc.askLocatingField(
      "pn",
      "971500000000",
      ctx({ country: "AE", currency: "AED" }),
    );
    expect(next).toBe("ASK_AREA");
    expect(sent[0]?.kind).toBe("list");
    expect(sent[0]?.rows).toEqual(["Dubai Marina", "JLT"]);
  });

  it("asks for nothing more where there are no postcodes and no area zones", async () => {
    // The dead end that mattered: the bot asked a Dubai caller for a postcode
    // and then sat in ASK_POSTCODE waiting for an answer that doesn't exist.
    const { svc, sent } = makeService([]);
    const next = await svc.askLocatingField(
      "pn",
      "971500000000",
      ctx({ country: "AE", currency: "AED" }),
    );
    expect(next).toBe("ORDERING");
    expect(sent).toHaveLength(0);
  });

  it("still asks for a postcode at a UK shop with no zones configured at all", async () => {
    const { svc } = makeService([]);
    expect(await svc.askLocatingField("pn", "44770", ctx())).toBe("ASK_POSTCODE");
  });
});

describe("sendAreaPicker", () => {
  it("sends a tappable list with the fee on each row", async () => {
    const { svc, sent } = makeService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: 40 },
    ]);
    await svc.sendAreaPicker("pn", "971500000000", ctx({ currency: "AED" }), "Which area?");
    expect(sent[0]?.kind).toBe("list");
    expect((svc.send.sendList as jest.Mock).mock.calls[0][4][0].rows[0].description).toBe(
      "AED 15.00 delivery · min AED 40.00",
    );
  });

  it("falls back to a text list rather than silently dropping areas past ten", async () => {
    // WhatsApp caps a list at 10 rows. Truncating would tell a customer we
    // don't deliver to an area we do — the one failure this picker exists to
    // prevent.
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `z${i}`,
      areaName: `Area ${String(i).padStart(2, "0")}`,
      fee: 10,
    }));
    const { svc, sent } = makeService(many);
    await svc.sendAreaPicker("pn", "971500000000", ctx({ currency: "AED" }), "Which area?");
    expect(sent[0]?.kind).toBe("text");
    for (const z of many) expect(sent[0]?.body).toContain(z.areaName);
  });
});

describe("resolveDeliveryFee", () => {
  it("prices the picked area", async () => {
    const { svc } = makeService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: 40 },
      { id: "jlt", areaName: "JLT", fee: 12 },
    ]);
    const out = await svc.resolveDeliveryFee(ctx({ currency: "AED" }), {
      area: "Dubai Marina",
    });
    expect(out).toMatchObject({
      mode: "AREA",
      matched: true,
      unserviceable: false,
      fee: 15,
      minOrder: 40,
      label: "Dubai Marina",
    });
  });

  it("reports an unlisted area as unserviceable", async () => {
    const { svc } = makeService([{ id: "marina", areaName: "Dubai Marina", fee: 15 }]);
    const out = await svc.resolveDeliveryFee(ctx(), { area: "Al Quoz" });
    expect(out.matched).toBe(false);
    expect(out.unserviceable).toBe(true);
  });

  it("does not let a leftover postcode price an area-mode shop", async () => {
    // A conversation started before the brand switched to areas can still be
    // carrying one on its cart.
    const { svc } = makeService([{ id: "marina", areaName: "Dubai Marina", fee: 15 }]);
    const out = await svc.resolveDeliveryFee(ctx(), { postcode: "SW1A 1AA" });
    expect(out.matched).toBe(false);
    expect(out.mode).toBe("AREA");
  });

  it("still does longest-prefix postcodes for a UK shop", async () => {
    const { svc } = makeService([
      { id: "broad", postcodePrefix: "SW1", fee: 3.5 },
      { id: "narrow", postcodePrefix: "SW1A", fee: 2 },
    ]);
    const out = await svc.resolveDeliveryFee(ctx(), { postcode: "SW1A 1AA" });
    expect(out).toMatchObject({ mode: "POSTCODE", matched: true, fee: 2 });
  });

  it("quotes the top band for distance zones rather than nothing", async () => {
    // A phone/chat conversation collects no coordinates, so the ceiling is the
    // honest quote; orders.create re-prices it from the address.
    const { svc } = makeService([
      { id: "near", maxDistanceMiles: 2, fee: 2 },
      { id: "far", maxDistanceMiles: 5, fee: 6 },
    ]);
    const out = await svc.resolveDeliveryFee(ctx(), { postcode: "SW1A 1AA" });
    expect(out).toMatchObject({ mode: "RADIUS", matched: true, fee: 6 });
  });

  it("has no zones and no opinion when the brand configured none", async () => {
    const { svc } = makeService([]);
    const out = await svc.resolveDeliveryFee(ctx(), { postcode: "SW1A 1AA" });
    expect(out.hasZones).toBe(false);
    expect(out.fee).toBe(0);
  });
});
