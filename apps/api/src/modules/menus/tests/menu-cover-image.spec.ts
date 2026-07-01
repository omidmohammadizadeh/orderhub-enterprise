import { MenusService } from "../menus.service";

// Menu banners are stored as inline data: URLs (no cloud storage yet), which
// Deliveroo can't fetch — so the public cover-image proxy decodes/streams them.
// This pins the resolution priority + data-URL decode.

function serviceWithMenu(menu: any): MenusService {
  const prisma = {
    menu: { findFirst: () => Promise.resolve(menu) },
  } as any;
  return new MenusService(prisma, {} as any, {} as any, {} as any);
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("MenusService.getMenuCoverImage", () => {
  it("decodes a base64 data-URL banner", async () => {
    const svc = serviceWithMenu({
      bannerImage: `data:image/png;base64,${b64("PNGDATA")}`,
      heroImage: null,
      logoImage: null,
      brand: null,
    });
    const { buffer, contentType } = await svc.getMenuCoverImage("m1");
    expect(contentType).toBe("image/png");
    expect(buffer.toString()).toBe("PNGDATA");
  });

  it("falls back banner → hero → logo → brand logo", async () => {
    const svc = serviceWithMenu({
      bannerImage: null,
      heroImage: null,
      logoImage: null,
      brand: { logoUrl: `data:image/gif;base64,${b64("GIF")}` },
    });
    const { contentType, buffer } = await svc.getMenuCoverImage("m1");
    expect(contentType).toBe("image/gif");
    expect(buffer.toString()).toBe("GIF");
  });

  it("throws when the menu has no usable image", async () => {
    const svc = serviceWithMenu({
      bannerImage: null,
      heroImage: null,
      logoImage: null,
      brand: null,
    });
    await expect(svc.getMenuCoverImage("m1")).rejects.toThrow();
  });

  it("throws when the menu doesn't exist", async () => {
    const svc = serviceWithMenu(null);
    await expect(svc.getMenuCoverImage("nope")).rejects.toThrow();
  });
});
