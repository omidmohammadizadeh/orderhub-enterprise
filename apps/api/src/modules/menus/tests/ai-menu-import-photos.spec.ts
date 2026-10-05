import { Logger } from "@nestjs/common";
import { classifyAiMenu, type AiMenuDraft } from "../importers/ai-menu.classifier";
import {
  isFetchableImageUrl,
  rehostProductImages,
} from "../importers/rehost-product-images";

// Photos in a JSON menu file: the classifier carries the link through, and
// the importer copies each one to our storage before the write. A photo we
// cannot fetch must import as NO photo for the JSON path (the link was the
// only copy we had), while Deliveroo keeps its historical "leave the URL".

const logger = new Logger("test");
beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

const storage = () =>
  ({
    isConfigured: () => true,
    uploadDataUrl: jest.fn(async () => `https://store.example.com/menu-import/${Math.random()}.jpg`),
  }) as any;

function mockFetch(byUrl: Record<string, { status: number; type?: string }>) {
  return jest.spyOn(global, "fetch").mockImplementation(async (input: any) => {
    const hit = byUrl[String(input)] ?? { status: 404 };
    return new Response(hit.status === 200 ? new Uint8Array([1, 2, 3]) : null, {
      status: hit.status,
      headers: { "content-type": hit.type ?? "image/jpeg" },
    });
  });
}

afterEach(() => jest.restoreAllMocks());

describe("classifyAiMenu — photos", () => {
  it("passes a web image link through and ignores anything else", () => {
    const draft: AiMenuDraft = {
      categories: [
        {
          name: "Pitas",
          items: [
            { name: "Chicken", price: 12, imageUrl: " https://cdn.example.com/a.jpg " },
            { name: "Halloumi", price: 11, imageUrl: "not a link" },
            { name: "Veggie", price: 11 },
          ],
        },
      ],
    };
    const n = classifyAiMenu(draft, "m1");
    expect(n.products.map((p) => p.imageUrl)).toEqual([
      "https://cdn.example.com/a.jpg",
      null,
      null,
    ]);
  });
});

describe("rehostProductImages", () => {
  it("copies each unique photo once and swaps in our URL", async () => {
    const fetchSpy = mockFetch({ "https://cdn.example.com/a.jpg": { status: 200 } });
    const store = storage();
    const products = [
      { imageUrl: "https://cdn.example.com/a.jpg" },
      { imageUrl: "https://cdn.example.com/a.jpg" },
    ];
    const r = await rehostProductImages(store, products, {
      folder: "menu-import", label: "t", logger, onFailure: "drop",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ attempted: 1, rehosted: 1, failed: 0 });
    expect(products[0]!.imageUrl).toMatch(/^https:\/\/store\.example\.com\//);
    expect(products[1]!.imageUrl).toBe(products[0]!.imageUrl);
  });

  it("drops a dead photo on the JSON path, keeps it for Deliveroo", async () => {
    mockFetch({});
    const drop = [{ imageUrl: "https://cdn.example.com/gone.jpg" }];
    await rehostProductImages(storage(), drop, { folder: "f", label: "t", logger, onFailure: "drop" });
    expect(drop[0]!.imageUrl).toBeNull();

    const keep = [{ imageUrl: "https://cdn.example.com/gone.jpg" }];
    await rehostProductImages(storage(), keep, { folder: "f", label: "t", logger, onFailure: "keep" });
    expect(keep[0]!.imageUrl).toBe("https://cdn.example.com/gone.jpg");
  });

  it("refuses a response that is not an image", async () => {
    mockFetch({ "https://cdn.example.com/page": { status: 200, type: "text/html" } });
    const products = [{ imageUrl: "https://cdn.example.com/page" }];
    const r = await rehostProductImages(storage(), products, { folder: "f", label: "t", logger, onFailure: "drop" });
    expect(r.failed).toBe(1);
    expect(products[0]!.imageUrl).toBeNull();
  });

  it("leaves our own origin alone", async () => {
    const fetchSpy = mockFetch({});
    const products = [{ imageUrl: "https://api.ours.example/api/img/1" }];
    await rehostProductImages(storage(), products, {
      folder: "f", label: "t", logger, onFailure: "drop", skipOrigins: ["https://api.ours.example"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(products[0]!.imageUrl).toBe("https://api.ours.example/api/img/1");
  });
});

describe("isFetchableImageUrl", () => {
  it("allows public hosts and refuses this server's own network", () => {
    expect(isFetchableImageUrl("https://rs-menus-api.roocdn.com/images/x/image.jpeg?width=800")).toBe(true);
    for (const u of [
      "http://localhost:3000/x.jpg",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/x.jpg",
      "http://[::1]/x.jpg",
      "http://db.internal/x.jpg",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(isFetchableImageUrl(u)).toBe(false);
    }
  });
});
