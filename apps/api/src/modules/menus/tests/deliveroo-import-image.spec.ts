import { relativiseImage } from "../importers/deliveroo-menu.importer";

// The dashboard loads images same-origin via the Next /api rewrite (Render
// strips CORS headers; helmet's default Cross-Origin-Resource-Policy makes
// browsers discard cross-origin <img> responses even on a 200). So imported
// image URLs pointing at OUR API origin must come back as relative /api/...
// paths, while genuinely external URLs pass through untouched.

describe("relativiseImage", () => {
  it("strips our API origin back to a relative /api path", () => {
    expect(
      relativiseImage(
        "https://orderhub-api-0re6.onrender.com/api/v1/menus/hubrise-image/1273j/bnb3em3",
      ),
    ).toBe("/api/v1/menus/hubrise-image/1273j/bnb3em3");
  });

  it("leaves relative paths and external hosts untouched", () => {
    expect(relativiseImage("/api/v1/menus/hubrise-image/a/b")).toBe(
      "/api/v1/menus/hubrise-image/a/b",
    );
    expect(relativiseImage("https://rs-menus-api.roocdn.com/images/x.jpg")).toBe(
      "https://rs-menus-api.roocdn.com/images/x.jpg",
    );
  });

  it("returns null for empty values", () => {
    expect(relativiseImage(null)).toBeNull();
    expect(relativiseImage("")).toBeNull();
    expect(relativiseImage(undefined)).toBeNull();
  });
});
