import {
  OrderingService,
  verifiedCustomDomain,
  pickStorefrontImage,
} from "../ordering.service";

// Every shop's storefront used to serve the site-wide B2B metadata — our
// pitch, our name — as its <title> and as the preview card for every link the
// shop pasted into WhatsApp. These are the two facts the fix rests on: which
// host is really the shop's, and whether the shop is selling at all.

describe("verifiedCustomDomain", () => {
  it("prefers the brand's domain — custom domains are sold per brand", () => {
    expect(
      verifiedCustomDomain(
        { customDomain: "order.pizzauno.com", customDomainStatus: "verified" },
        { customDomain: "old.pizzauno.com", customDomainStatus: "verified" },
      ),
    ).toBe("order.pizzauno.com");
  });

  it("falls back to the location's older per-location domain", () => {
    expect(
      verifiedCustomDomain(
        { customDomain: null, customDomainStatus: "not_configured" },
        { customDomain: "order.chinachef.co.uk", customDomainStatus: "verified" },
      ),
    ).toBe("order.chinachef.co.uk");
  });

  // The one that matters. A domain sits at "pending" for as long as the
  // operator's DNS is wrong, and Cloudflare has issued no certificate for it.
  // Naming it as canonical points Google at a URL that does not serve.
  it("REFUSES a domain Cloudflare has not verified", () => {
    expect(
      verifiedCustomDomain(
        { customDomain: "order.pizzauno.com", customDomainStatus: "pending" },
        null,
      ),
    ).toBeNull();
  });

  it("is null when nobody has a domain", () => {
    expect(verifiedCustomDomain({}, {})).toBeNull();
    expect(verifiedCustomDomain(null, null)).toBeNull();
  });

  it("normalises the host — a canonical is compared as a string", () => {
    expect(
      verifiedCustomDomain(
        { customDomain: "  Order.PizzaUno.com ", customDomainStatus: "verified" },
        null,
      ),
    ).toBe("order.pizzauno.com");
  });
});

describe("getStorefrontSeo", () => {
  /** Project a fake storefront read through the real method. */
  function seoOf(store: any) {
    const service = Object.create(OrderingService.prototype) as OrderingService;
    (service as any).getStorefrontBySlug = jest.fn().mockResolvedValue(store);
    return service.getStorefrontSeo("pizza-uno-pelton");
  }

  const LIVE_SHOP = {
    location: {
      name: "Pizza Uno Pelton",
      about: "Stone-baked pizza, kebabs and burgers.",
      city: "Chester-le-Street",
      postcode: "DH2 2QA",
      logoUrl: "https://cdn.example.com/logo.png",
    },
    brand: { cuisine: "Pizza", logoUrl: null },
    directConfig: { heroImageUrl: "https://cdn.example.com/hero.jpg" },
    seo: { customDomain: "order.pizzauno.com", directOrderingEnabled: true },
    menu: {
      bannerImage: "https://cdn.example.com/banner.jpg",
      categories: [{ items: [{ item: { id: "i1" } }] }],
    },
  };

  it("returns the shop's own identity, not ours", async () => {
    await expect(seoOf(LIVE_SHOP)).resolves.toMatchObject({
      name: "Pizza Uno Pelton",
      about: "Stone-baked pizza, kebabs and burgers.",
      cuisine: "Pizza",
      city: "Chester-le-Street",
      customDomain: "order.pizzauno.com",
      hasMenu: true,
    });
  });

  it("previews the banner the customer is about to see", async () => {
    await expect(seoOf(LIVE_SHOP)).resolves.toMatchObject({
      image: "https://cdn.example.com/banner.jpg",
      hasStoredImage: false,
    });
  });

  // Pizza Uno's real banner is 703KB of base64 in a Postgres column. Shipping
  // it here put 703KB into a response fetched on every metadata revalidation,
  // for a string no crawler can fetch anyway.
  it("never ships a data URI — it reports one instead", async () => {
    const stored = {
      ...LIVE_SHOP,
      menu: {
        ...LIVE_SHOP.menu,
        bannerImage: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==",
      },
    };
    await expect(seoOf(stored)).resolves.toMatchObject({
      image: null,
      hasStoredImage: true,
    });
  });

  it("falls back down to the logo when the shop set no banner", async () => {
    const noBanner = {
      ...LIVE_SHOP,
      menu: { categories: LIVE_SHOP.menu.categories },
      directConfig: {},
    };
    await expect(seoOf(noBanner)).resolves.toMatchObject({
      image: "https://cdn.example.com/logo.png",
    });
  });

  it("reports no image at all when the shop has none", async () => {
    const bare = {
      ...LIVE_SHOP,
      menu: { categories: LIVE_SHOP.menu.categories },
      directConfig: {},
      brand: { cuisine: "Pizza", logoUrl: null },
      location: { ...LIVE_SHOP.location, logoUrl: null },
    };
    await expect(seoOf(bare)).resolves.toMatchObject({
      image: null,
      hasStoredImage: false,
    });
  });

  // "Is this shop live" — the signal the web app turns into robots:noindex.
  it("reports an empty storefront as having no menu", async () => {
    await expect(
      seoOf({ ...LIVE_SHOP, menu: { categories: [{ items: [] }] } }),
    ).resolves.toMatchObject({ hasMenu: false });

    await expect(seoOf({ ...LIVE_SHOP, menu: null })).resolves.toMatchObject({
      hasMenu: false,
    });
  });

  // Closed for the night is not "not live". Every shop is shut most of the
  // day, and de-listing them each evening would be far worse than listing a
  // shut shop, so `closed` must not leak into this projection at all.
  it("says nothing about a shop being closed right now", async () => {
    const shut = { ...LIVE_SHOP, isOpen: false, closed: { reason: "Too busy" } };
    await expect(seoOf(shut)).resolves.toMatchObject({
      hasMenu: true,
      directOrderingEnabled: true,
    });
  });

  it("carries direct ordering being switched off", async () => {
    await expect(
      seoOf({ ...LIVE_SHOP, seo: { customDomain: null, directOrderingEnabled: false } }),
    ).resolves.toMatchObject({ directOrderingEnabled: false, customDomain: null });
  });

  // The response is fetched on every cold storefront render, so it must stay
  // small — the whole reason it isn't just the full storefront read, which
  // carries the entire menu.
  it("carries no menu, zones or promos", async () => {
    const seo = (await seoOf(LIVE_SHOP)) as Record<string, unknown>;
    expect(Object.keys(seo).sort()).toEqual([
      "about",
      "city",
      "cuisine",
      "customDomain",
      "directOrderingEnabled",
      "hasMenu",
      "hasStoredImage",
      "image",
      "name",
      "postcode",
    ]);
  });
});

describe("pickStorefrontImage", () => {
  it("prefers the banner, then the hero, then config, then the logos", () => {
    const store: any = {
      menu: { bannerImage: "banner", heroImage: "hero" },
      directConfig: { heroImageUrl: "config" },
      brand: { logoUrl: "brand-logo" },
      location: { logoUrl: "location-logo" },
    };
    expect(pickStorefrontImage(store)).toBe("banner");
    delete store.menu.bannerImage;
    expect(pickStorefrontImage(store)).toBe("hero");
    delete store.menu.heroImage;
    expect(pickStorefrontImage(store)).toBe("config");
    delete store.directConfig.heroImageUrl;
    expect(pickStorefrontImage(store)).toBe("brand-logo");
    delete store.brand.logoUrl;
    expect(pickStorefrontImage(store)).toBe("location-logo");
  });

  it("treats blank and missing columns alike", () => {
    expect(pickStorefrontImage({ menu: { bannerImage: "   " } })).toBeNull();
    expect(pickStorefrontImage({})).toBeNull();
    expect(pickStorefrontImage(null)).toBeNull();
  });
});

describe("getStorefrontPreviewImage", () => {
  function imageOf(store: any) {
    const service = Object.create(OrderingService.prototype) as OrderingService;
    (service as any).getStorefrontBySlug = jest.fn().mockResolvedValue(store);
    return service.getStorefrontPreviewImage("pizza-uno-pelton");
  }

  // One black JPEG-ish byte run is enough — this decodes base64, it does not
  // parse images.
  const PIXEL = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";

  it("decodes the stored banner into bytes a crawler can fetch", async () => {
    const result = await imageOf({
      menu: { bannerImage: `data:image/jpeg;base64,${PIXEL}` },
    });
    expect(result?.contentType).toBe("image/jpeg");
    expect(result?.buffer.length).toBeGreaterThan(0);
    expect(result?.buffer).toEqual(Buffer.from(PIXEL, "base64"));
  });

  it("keeps the stored mime type rather than guessing one", async () => {
    const result = await imageOf({
      menu: { bannerImage: `data:image/PNG;base64,${PIXEL}` },
    });
    expect(result?.contentType).toBe("image/png");
  });

  // A shop whose banner is already a URL needs nothing from this route — the
  // metadata points og:image straight at it.
  it("returns nothing for an image that already has a URL", async () => {
    await expect(
      imageOf({ menu: { bannerImage: "https://cdn.example.com/banner.jpg" } }),
    ).resolves.toBeNull();
  });

  it("returns nothing when the shop has no image", async () => {
    await expect(imageOf({})).resolves.toBeNull();
  });

  // Serving zero bytes as an image is worse than serving nothing: the crawler
  // renders a broken card instead of falling back to a text-only one.
  it("refuses a data URI that decodes to nothing", async () => {
    await expect(
      imageOf({ menu: { bannerImage: "data:image/jpeg;base64," } }),
    ).resolves.toBeNull();
  });

  it("refuses a non-image data URI", async () => {
    await expect(
      imageOf({ menu: { bannerImage: "data:text/html;base64,PHNjcmlwdD4=" } }),
    ).resolves.toBeNull();
  });
});
