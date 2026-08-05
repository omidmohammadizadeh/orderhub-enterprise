import { rehostImageIfInline } from "../rehost-image";

// Logos arrive from the dashboard as base64 and used to be stored that way,
// which put the whole picture inside every storefront response — uncacheable,
// and 31% of a 2MB payload on one real shop. Anything inline is now uploaded
// on the way in and only the URL is kept.
//
// The failure behaviour matters as much as the happy path: a logo that can't
// be uploaded must not stop an operator saving their opening hours.

const DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function storage(over: Partial<any> = {}) {
  return {
    isConfigured: () => true,
    uploadDataUrl: async () => "https://cdn.example.com/logos/abc.png",
    ...over,
  } as any;
}

describe("rehostImageIfInline", () => {
  it("uploads an inline image and returns the hosted URL", async () => {
    const out = await rehostImageIfInline(storage(), DATA_URI, "logos");
    expect(out).toBe("https://cdn.example.com/logos/abc.png");
  });

  it("passes an already-hosted URL straight through, without uploading", async () => {
    let called = false;
    const s = storage({
      uploadDataUrl: async () => {
        called = true;
        return "nope";
      },
    });
    const url = "https://cdn.example.com/logos/existing.png";
    expect(await rehostImageIfInline(s, url, "logos")).toBe(url);
    expect(called).toBe(false);
  });

  it("leaves undefined alone, so a PATCH that omits the logo doesn't clear it", async () => {
    expect(await rehostImageIfInline(storage(), undefined, "logos")).toBeUndefined();
  });

  it("leaves null alone, so clearing a logo still clears it", async () => {
    expect(await rehostImageIfInline(storage(), null, "logos")).toBeNull();
  });

  it("keeps the image inline when storage isn't configured", async () => {
    const s = storage({ isConfigured: () => false });
    expect(await rehostImageIfInline(s, DATA_URI, "logos")).toBe(DATA_URI);
  });

  it("keeps the image inline when the upload throws, rather than failing the save", async () => {
    const s = storage({
      uploadDataUrl: async () => {
        throw new Error("bucket unreachable");
      },
    });
    expect(await rehostImageIfInline(s, DATA_URI, "logos")).toBe(DATA_URI);
  });

  it("survives storage being absent entirely", async () => {
    expect(await rehostImageIfInline(null, DATA_URI, "logos")).toBe(DATA_URI);
  });
});
