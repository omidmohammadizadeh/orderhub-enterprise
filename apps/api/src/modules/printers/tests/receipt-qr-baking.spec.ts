import { PrintJobsService } from "../print-jobs.service";
import {
  buildStorefrontQrUrl,
  isMarketplaceSource,
} from "../../marketing/receipt-qr-url";

// The QR raster is baked into the print-job payload for printers the API
// renders itself (LAN, no agent). The scoping is the whole safety story:
// Bluetooth tablets rasterise their own QR in the browser from `qrData`, so a
// baked raster reaching one of those payloads would print TWO QR codes on one
// receipt. These tests pin the boundary.

const ORDER = {
  id: "ord-1",
  tenantId: "t1",
  locationId: "loc-1",
  brandId: "brand-plumbing",
  orderSource: "HUBRISE",
  platform: "HUBRISE",
};

const LOCATION = {
  id: "loc-1",
  slug: null,
  brandId: "brand-shop",
  onlineOrderingSlug: null,
};

/** Brand the order was mapped to — HubRise plumbing brand, no storefront. */
const PLUMBING_BRAND = { onlineOrderingSlug: null, directOrderingEnabled: false };

function makeService(printers: any[]) {
  const prisma: any = {
    printer: { findMany: async () => printers },
    location: { findUnique: async () => LOCATION },
    brand: { findUnique: async () => PLUMBING_BRAND },
  };
  const svc = new PrintJobsService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return svc;
}

const bake = (svc: any, targets: any[], order: any = ORDER) =>
  (svc as any).bakeQrForServerRenderedReceipts(targets, order);

const LAN = {
  id: "p-lan",
  paperWidth: 80,
  defaults: { qrCode: true },
};

const receiptTarget = (printerId: string) => ({
  type: "CUSTOMER_RECEIPT",
  printerId,
  payload: { orderNumber: "ABC12" },
});

describe("receipt QR baking — what gets one", () => {
  it("bakes a raster for a server-rendered LAN printer", async () => {
    const svc = makeService([LAN]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets);

    expect(typeof targets[0].payload.qrRaster).toBe("string");
    // GS v 0 header survives the base64 round-trip.
    const bytes = Buffer.from(targets[0].payload.qrRaster, "base64");
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x1d, 0x76, 0x30, 0x00]);
  });

  it("leaves the rest of the payload alone", async () => {
    const svc = makeService([LAN]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets);
    expect(targets[0].payload.orderNumber).toBe("ABC12");
  });

  it("uses the field the renderer reads, never the browser's qrData", async () => {
    // Setting qrData here is what would make a tablet render this one too.
    const svc = makeService([LAN]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets);
    expect(targets[0].payload.qrData).toBeUndefined();
  });
});

describe("receipt QR baking — what must NOT get one", () => {
  it("skips a printer the query didn't return as server-rendered", async () => {
    // A Bluetooth printer never comes back from that query (it has an agent
    // or a non-LAN connectionType), so its payload must be untouched — two
    // QR codes on one receipt is the failure this prevents.
    const svc = makeService([]);
    const targets = [receiptTarget("p-bluetooth")];
    await bake(svc, targets);
    expect(targets[0].payload).toEqual({ orderNumber: "ABC12" });
  });

  it("skips a LAN printer with the QR default switched off", async () => {
    const svc = makeService([{ ...LAN, defaults: { qrCode: false } }]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets);
    expect(targets[0].payload.qrRaster).toBeUndefined();
  });

  it("skips a LAN printer with no defaults at all", async () => {
    const svc = makeService([{ ...LAN, defaults: null }]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets);
    expect(targets[0].payload.qrRaster).toBeUndefined();
  });

  it("skips a direct-channel order", async () => {
    // Someone who ordered on our own storefront doesn't need telling to.
    const svc = makeService([LAN]);
    const targets = [receiptTarget("p-lan")];
    await bake(svc, targets, { ...ORDER, orderSource: "ONLINE", platform: "ONLINE" });
    expect(targets[0].payload.qrRaster).toBeUndefined();
  });

  it("skips kitchen tickets", async () => {
    const svc = makeService([LAN]);
    const targets = [{ type: "KITCHEN_TICKET", printerId: "p-lan", payload: {} }];
    await bake(svc, targets);
    expect(targets[0].payload.qrRaster).toBeUndefined();
  });

  it("never throws when the lookup blows up", async () => {
    // A receipt without its marketing QR is a nuisance; a receipt that failed
    // to print is a lost order.
    const prisma: any = {
      printer: {
        findMany: async () => {
          throw new Error("db down");
        },
      },
    };
    const svc = new PrintJobsService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    const targets = [receiptTarget("p-lan")];
    await expect(
      (svc as any).bakeQrForServerRenderedReceipts(targets, ORDER),
    ).resolves.toBeUndefined();
    expect(targets[0].payload.qrRaster).toBeUndefined();
  });
});

describe("receipt QR url — shared by both print paths", () => {
  const base = "https://www.orderhubsolutions.com";

  it("sends a HubRise-relayed order to the LOCATION's brand", async () => {
    // The order's brand is the plumbing brand HubRise mapped it to. Pointing
    // the QR there lands the customer on a storefront wearing the wrong name.
    const { url, storefrontBrandId } = buildStorefrontQrUrl({
      brandId: "brand-plumbing",
      brand: PLUMBING_BRAND,
      loc: LOCATION,
      base,
    });
    expect(storefrontBrandId).toBe("brand-shop");
    expect(url).toContain("brand=brand-shop");
  });

  it("falls back to the location id when no slug was ever set", () => {
    const { url } = buildStorefrontQrUrl({
      brandId: "b",
      brand: null,
      loc: LOCATION,
      base,
    });
    expect(url).toBe(`${base}/order/loc-1?brand=brand-shop`);
  });

  it("prefers the brand's own storefront when it has one", () => {
    const { url, storefrontBrandId } = buildStorefrontQrUrl({
      brandId: "brand-real",
      brand: { onlineOrderingSlug: "grill-stop", directOrderingEnabled: true },
      loc: LOCATION,
      base,
    });
    expect(url).toBe(`${base}/brand/grill-stop`);
    expect(storefrontBrandId).toBe("brand-real");
  });

  it("says why when it can't build one", () => {
    const { url, reason } = buildStorefrontQrUrl({
      brandId: "b",
      brand: null,
      loc: null,
      base,
    });
    expect(url).toBeNull();
    expect(reason).toMatch(/no brand slug and no location/i);
  });

  it("treats the marketplaces as marketplaces and our own channels as not", () => {
    for (const s of ["UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE"]) {
      expect(isMarketplaceSource(s, null)).toBe(true);
    }
    for (const s of ["ONLINE", "POS", "PHONE", "WHATSAPP", "DIRECT"]) {
      expect(isMarketplaceSource(s, null)).toBe(false);
    }
    expect(isMarketplaceSource(null, null)).toBe(false);
  });
});
