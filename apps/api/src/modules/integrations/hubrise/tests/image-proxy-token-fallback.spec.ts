// Why Pizza Uno's menu photos were broken on the storefront and in marketing
// emails: the image proxy took the FIRST shop carrying the catalog id, that
// shop's HubRise token had expired (401), and a sibling shop with a working
// token was never tried.

import { HubRiseCatalogService } from "../hubrise-catalog.service";

function makeService(locations: { hubriseCredentials: unknown }[]) {
  const svc = Object.create(HubRiseCatalogService.prototype) as any;
  svc.config = { get: () => "https://api.hubrise.com/v1" };
  svc.credentialEncryption = { decrypt: (c: any) => c };
  svc.prisma = { location: { findMany: jest.fn().mockResolvedValue(locations) } };
  return svc;
}

const image = {
  ok: true,
  status: 200,
  headers: { get: () => "image/png" },
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
};

describe("HubRise image proxy", () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it("moves on to the next shop's token when one is refused", async () => {
    const svc = makeService([
      { hubriseCredentials: { accessToken: "expired" } },
      { hubriseCredentials: { accessToken: "good" } },
    ]);
    const tokens: string[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      tokens.push(init.headers["X-Access-Token"]);
      return init.headers["X-Access-Token"] === "good" ? image : { ok: false, status: 401 };
    });
    const out = await svc.fetchHubRiseImage("cat1", "img1");
    expect(tokens).toEqual(["expired", "good"]);
    expect(out.contentType).toBe("image/png");
    expect(out.buffer.length).toBe(3);
  });

  it("does not retry a missing image with every token", async () => {
    const svc = makeService([
      { hubriseCredentials: { accessToken: "a" } },
      { hubriseCredentials: { accessToken: "b" } },
    ]);
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    await expect(svc.fetchHubRiseImage("cat1", "img1")).rejects.toThrow("→ 404");
    expect((global as any).fetch).toHaveBeenCalledTimes(1);
  });

  it("skips a shop with no token and reports when none has one", async () => {
    const svc = makeService([{ hubriseCredentials: {} }]);
    (global as any).fetch = jest.fn();
    await expect(svc.fetchHubRiseImage("cat1", "img1")).rejects.toThrow("No HubRise token");
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it("404s an unknown catalog", async () => {
    const svc = makeService([]);
    await expect(svc.fetchHubRiseImage("nope", "img1")).rejects.toThrow("HubRise catalog not found");
  });
});
