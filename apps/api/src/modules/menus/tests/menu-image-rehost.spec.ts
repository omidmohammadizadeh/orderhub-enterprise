import { MenusService } from "../menus.service";

// Brand and location logos were already rehosted on write. Menus were not —
// which is how Pizza Uno Pelton ended up serving a 703KB base64 banner inside
// every storefront response (18% of a 3.8MB payload) that no link-preview
// crawler could fetch. These cover the write-time net for the columns that
// were missing one.
//
// The dashboard uploader normally uploads to Supabase itself and only falls
// back to a data URI when that fails, so this net is what catches the
// fallback — and every older client that never uploaded at all.

const DATA_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";
const HOSTED = "https://cdn.example.com/menus/abc.jpg";

function storage(over: Partial<any> = {}) {
  return {
    isConfigured: () => true,
    uploadDataUrl: jest.fn(async () => HOSTED),
    ...over,
  } as any;
}

/** A MenusService with only the collaborators these paths touch. */
function service(store: any) {
  const svc = Object.create(MenusService.prototype) as any;
  svc.storage = store;
  return svc;
}

describe("menu image rehosting", () => {
  it("uploads an inline banner and keeps only the URL", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline(
      { name: "Main menu", bannerImage: DATA_URI },
      ["bannerImage", "logoImage", "heroImage"],
      "menus",
    );
    expect(out.bannerImage).toBe(HOSTED);
    expect(svc.storage.uploadDataUrl).toHaveBeenCalledWith(DATA_URI, "menus");
  });

  it("leaves every other field on the DTO alone", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline(
      { name: "Main menu", description: "Everything", bannerImage: DATA_URI },
      ["bannerImage"],
      "menus",
    );
    expect(out).toMatchObject({ name: "Main menu", description: "Everything" });
  });

  it("passes an already-hosted URL straight through", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline(
      { bannerImage: "https://cdn.example.com/existing.jpg" },
      ["bannerImage"],
      "menus",
    );
    expect(out.bannerImage).toBe("https://cdn.example.com/existing.jpg");
    expect(svc.storage.uploadDataUrl).not.toHaveBeenCalled();
  });

  // A PATCH that doesn't mention the banner must not touch it. Rehosting an
  // absent field would write `null` over a banner the operator still has.
  it("does not invent a field the caller never sent", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline({ name: "Renamed" }, ["bannerImage"], "menus");
    expect("bannerImage" in out).toBe(false);
  });

  // Clearing an image is a real edit and has to survive.
  it("keeps an explicit null", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline({ bannerImage: null }, ["bannerImage"], "menus");
    expect(out.bannerImage).toBeNull();
  });

  it("handles every image column on one save", async () => {
    const svc = service(storage());
    const out = await svc.rehostInline(
      { bannerImage: DATA_URI, logoImage: DATA_URI, heroImage: DATA_URI },
      ["bannerImage", "logoImage", "heroImage"],
      "menus",
    );
    expect([out.bannerImage, out.logoImage, out.heroImage]).toEqual([
      HOSTED,
      HOSTED,
      HOSTED,
    ]);
    expect(svc.storage.uploadDataUrl).toHaveBeenCalledTimes(3);
  });

  // The whole point of rehostImageIfInline's contract: an image that will not
  // upload must not stop the operator saving the rest of the form. It stays
  // inline — exactly today's behaviour — rather than throwing.
  it("saves the menu anyway when the upload fails", async () => {
    const svc = service(
      storage({
        uploadDataUrl: jest.fn(async () => {
          throw new Error("bucket is full");
        }),
      }),
    );
    const out = await svc.rehostInline(
      { name: "Main menu", bannerImage: DATA_URI },
      ["bannerImage"],
      "menus",
    );
    expect(out.bannerImage).toBe(DATA_URI);
    expect(out.name).toBe("Main menu");
  });

  it("degrades quietly when storage is not configured at all", async () => {
    const svc = service(storage({ isConfigured: () => false }));
    const out = await svc.rehostInline({ bannerImage: DATA_URI }, ["bannerImage"], "menus");
    expect(out.bannerImage).toBe(DATA_URI);
  });
});
