// Why a master menu built from several source menus published to HubRise
// with most of its photos missing.
//
// Both failures are silent by construction: attachProductImages catches
// everything and moves on, because "an image must never break the publish".
// The product simply arrives with no image_ids and nobody is told. That is
// the right call for one bad photo and the wrong one for a whole menu, so
// the two causes are pinned here.

import { HubRiseCatalogService } from "../hubrise-catalog.service";

function makeService() {
  const svc = Object.create(HubRiseCatalogService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.config = { get: () => "https://api.hubrise.com/v1" };
  return svc;
}

const okJson = (body: any) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

describe("HubRise image upload — private_ref collision", () => {
  it("keeps the image when the ref is already taken, instead of dropping it", async () => {
    // HubRise does not dedupe on private_ref, it rejects. Every republish of
    // an image already in the catalog 422'd, and the product lost its photo.
    const calls: string[] = [];
    const svc = makeService();
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("private_ref")) {
        return {
          ok: false,
          status: 422,
          text: async () =>
            JSON.stringify({
              errors: [
                { field: "/private_ref", message: "is already used ('abc' given)" },
              ],
            }),
        };
      }
      return okJson({ id: "img_new" });
    }) as any;

    const id = await svc.uploadImageToCatalog(
      "999rj",
      "tok",
      Buffer.from([0xff, 0xd8, 0xff]),
      "image/jpeg",
      "abc",
    );

    expect(id).toBe("img_new");
    // First attempt keeps the ref (so a genuinely new image still dedupes);
    // only the collision retries without it.
    expect(calls[0]).toContain("private_ref=abc");
    expect(calls[1]).not.toContain("private_ref");
  });

  it("still surfaces a genuine upload failure", async () => {
    const svc = makeService();
    global.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    })) as any;

    await expect(
      svc.uploadImageToCatalog("999rj", "tok", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "abc"),
    ).rejects.toThrow(/500/);
  });
});

describe("HubRise 1 MB image cap", () => {
  // Real bytes through the real encoder — a mocked sharp would prove nothing
  // about whether a 2 MB marketplace PNG actually fits afterwards.
  const bigPng = async (): Promise<Buffer> => {
    const sharp = require("sharp");
    // Genuinely incompressible bytes. An arithmetic "noise" pattern is not:
    // the first version of this used one and PNG crushed it to 29KB, so the
    // test proved nothing about oversized images.
    const px = 1000;
    const raw = require("crypto").randomBytes(px * px * 3);
    return sharp(raw, { raw: { width: px, height: px, channels: 3 } })
      .png()
      .toBuffer();
  };

  it("shrinks an oversized photo under the cap instead of dropping it", async () => {
    const source = await bigPng();
    expect(source.length).toBeGreaterThan(1_000_000);

    const svc = makeService();
    const out = await svc.compressForHubRise(source);

    expect(out).not.toBeNull();
    expect(out.mime).toBe("image/jpeg");
    expect(out.buffer.length).toBeLessThanOrEqual(1_000_000);
  }, 30_000);

  it("uploads the compressed bytes rather than failing the product", async () => {
    const source = await bigPng();
    const svc = makeService();
    let sentBytes = 0;
    global.fetch = (async (_url: string, init: any) => {
      sentBytes = init.body.length;
      return okJson({ id: "img_small" });
    }) as any;

    const id = await svc.uploadImageToCatalog(
      "999rj",
      "tok",
      source,
      "image/png",
    );

    expect(id).toBe("img_small");
    expect(sentBytes).toBeLessThanOrEqual(1_000_000);
  }, 30_000);

  it("still refuses when the image can't be compressed", async () => {
    const svc = makeService();
    svc.compressForHubRise = async () => null;
    await expect(
      svc.uploadImageToCatalog(
        "999rj",
        "tok",
        Buffer.alloc(2_000_000, 1),
        "image/png",
      ),
    ).rejects.toThrow(/HubRise max is 1MB/);
  });
});

describe("HubRise image source — stale catalog", () => {
  it("reads an older catalog with the publishing token", async () => {
    // Items imported from a previous catalog (a Deliveroo import) point at an
    // id no Location.hubriseCatalogId holds any more, so the credential
    // lookup threw "catalog not found" and the image was dropped. The catalog
    // is still readable with this account's token.
    const svc = makeService();
    svc.fetchHubRiseImage = async () => {
      throw new Error("HubRise catalog not found");
    };
    global.fetch = (async (url: string) => {
      expect(String(url)).toContain("/catalogs/1273j/images/bnb3em3/data");
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
        headers: { get: () => "image/jpeg" },
      };
    }) as any;

    const bytes = await svc.resolveImageBytes(
      "/api/v1/menus/hubrise-image/1273j/bnb3em3",
      "tok",
    );
    expect(bytes?.contentType).toBe("image/jpeg");
  });

  it("reads a sibling brand's catalog when the publishing token can't", async () => {
    // The real Castle Grill case: the master menu's Greek Gyros and Monster
    // Burgerz items were imported under those brands' OWN HubRise accounts,
    // so the publishing location's token gets 404 on their catalog and no
    // Location row points at it any more either.
    const svc = makeService();
    svc.fetchHubRiseImage = async () => {
      throw new Error("HubRise catalog not found");
    };
    svc.credentialEncryption = {
      decrypt: (c: any) => ({ accessToken: c.t }),
    };
    svc.prisma = {
      location: {
        findMany: async () => [
          { id: "loc-other", hubriseCredentials: { t: "sibling-tok" } },
        ],
      },
    };
    global.fetch = (async (url: string, init: any) => {
      const token = init?.headers?.["X-Access-Token"];
      // Only the sibling brand's token can read catalog 1273j.
      if (token !== "sibling-tok") return { ok: false, status: 404 };
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
        headers: { get: () => "image/jpeg" },
      };
    }) as any;

    const bytes = await svc.resolveImageBytes(
      "/api/v1/menus/hubrise-image/1273j/bnb3em3",
      "publishing-tok",
      "tenant-1",
    );
    expect(bytes?.contentType).toBe("image/jpeg");
  });

  it("falls back to the catalog-id lookup when there's no token", async () => {
    // The public image proxy has no publishing context, so the original
    // resolution path has to stay intact.
    const svc = makeService();
    let usedFallback = false;
    svc.fetchHubRiseImage = async () => {
      usedFallback = true;
      return { buffer: Buffer.from([1]), contentType: "image/png" };
    };
    const bytes = await svc.resolveImageBytes(
      "/api/v1/menus/hubrise-image/999rj/xyz",
    );
    expect(usedFallback).toBe(true);
    expect(bytes?.contentType).toBe("image/png");
  });
});
