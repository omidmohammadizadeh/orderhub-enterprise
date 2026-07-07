import { DeliverooMenuImporter } from "../deliveroo-menu.importer";

// Deliveroo hands back product images on HubRise's app CDN
// (deliveroo.hubrise-apps.com) that expire → 400 by render time, which is
// why Deliveroo imports showed no images while Uber (which rehosts) did.
// rehostImages must: fetch EXTERNAL urls and swap them for our stored copy,
// leave our-own-origin urls for relativiseImage(), and leave a url untouched
// when the fetch fails (best-effort).

const PROD = "https://orderhub-api-0re6.onrender.com";

function makeImporter(fetchImpl: jest.Mock) {
  (globalThis as any).fetch = fetchImpl;
  const storage = {
    isConfigured: () => true,
    uploadDataUrl: jest.fn(async () => "https://supabase.example/stored.jpg"),
  } as any;
  return new DeliverooMenuImporter(
    {} as any, // prisma
    {} as any, // writer
    {} as any, // deliveroo client
    storage,
  );
}

const imgResponse = () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  }) as any;

describe("DeliverooMenuImporter.rehostImages", () => {
  it("rehosts an external CDN url to our storage", async () => {
    const fetchMock = jest.fn(async () => imgResponse());
    const importer = makeImporter(fetchMock);
    const normalized = {
      products: [
        { imageUrl: "https://deliveroo.hubrise-apps.com/images/abc?app_instance_id=x" },
      ],
    };
    await (importer as any).rehostImages(normalized);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(normalized.products[0].imageUrl).toBe(
      "https://supabase.example/stored.jpg",
    );
  });

  it("leaves our-own-origin urls untouched (relativiseImage handles them)", async () => {
    const fetchMock = jest.fn(async () => imgResponse());
    const importer = makeImporter(fetchMock);
    const url = `${PROD}/api/v1/menus/cover/xyz`;
    const normalized = { products: [{ imageUrl: url }] };
    await (importer as any).rehostImages(normalized);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(normalized.products[0].imageUrl).toBe(url);
  });

  it("leaves the url untouched when the image fetch fails (expired/400)", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => "text/html" },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const importer = makeImporter(fetchMock);
    const url = "https://deliveroo.hubrise-apps.com/images/stale?app_instance_id=old";
    const normalized = { products: [{ imageUrl: url }] };
    await (importer as any).rehostImages(normalized);
    expect(normalized.products[0].imageUrl).toBe(url);
  });

  it("no-ops when storage isn't configured", async () => {
    const fetchMock = jest.fn(async () => imgResponse());
    (globalThis as any).fetch = fetchMock;
    const importer = new DeliverooMenuImporter(
      {} as any,
      {} as any,
      {} as any,
      { isConfigured: () => false } as any,
    );
    const normalized = {
      products: [{ imageUrl: "https://deliveroo.hubrise-apps.com/images/abc" }],
    };
    await (importer as any).rehostImages(normalized);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
