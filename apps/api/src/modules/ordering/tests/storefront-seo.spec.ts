import { OrderingService, verifiedCustomDomain } from "../ordering.service";

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
      "image",
      "name",
      "postcode",
    ]);
  });
});
