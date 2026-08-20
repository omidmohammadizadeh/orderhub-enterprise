import { JetCredentialResolver } from "../jet-credential.resolver";

// JET is not OAuth. It issues API keys whose scope depends on both the
// operation and the restaurant: MENU keys are per COUNTRY (and per BRAND for
// brands over 6 locations), ORDER keys are separate again. A single
// platform-level secret — the shape Deliveroo and Uber use — cannot express
// that, so these tests pin the three-tier fallback.

const PLATFORM_MENU = "platform-menu-key";
const PLATFORM_ORDER = "platform-order-key";

function makeResolver(
  opts: {
    config?: Record<string, string>;
    connection?: { metadata: any } | null;
  } = {},
) {
  const values: Record<string, string> = {
    "app.platforms.jet.menuApiKey": PLATFORM_MENU,
    "app.platforms.jet.orderApiKey": PLATFORM_ORDER,
    "app.platforms.jet.menuKeysByCountry": "",
    "app.platforms.jet.orderKeysByCountry": "",
    "app.platforms.jet.defaultCountry": "GB",
    ...(opts.config ?? {}),
  };
  const config = { get: (k: string) => values[k] ?? "" } as any;
  const findFirst = jest.fn(async () => opts.connection ?? null);
  const prisma = { brandPlatformConnection: { findFirst } } as any;
  // Mirrors CredentialEncryptionService's behaviour with no key configured:
  // records round-trip unchanged.
  const crypto = {
    encrypt: (r: Record<string, unknown>) => r,
    decrypt: (r: Record<string, unknown>) => r,
  } as any;
  return { resolver: new JetCredentialResolver(config, prisma, crypto), findFirst };
}

describe("JetCredentialResolver — tier precedence", () => {
  it("falls back to the platform key when nothing more specific exists", async () => {
    const { resolver } = makeResolver();
    await expect(resolver.resolve({ type: "menu" })).resolves.toEqual({
      key: PLATFORM_MENU,
      source: "platform",
    });
  });

  it("keeps the menu and order keys apart", async () => {
    // Using the menu key on an order ack (or vice versa) 403s. They are
    // different keys, not two names for one.
    const { resolver } = makeResolver();
    const menu = await resolver.resolve({ type: "menu" });
    const order = await resolver.resolve({ type: "order" });
    expect(menu.key).toBe(PLATFORM_MENU);
    expect(order.key).toBe(PLATFORM_ORDER);
  });

  it("prefers a country key over the platform default", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": "GB:gb-key,IE:ie-key" },
    });
    await expect(resolver.resolve({ type: "menu", country: "IE" })).resolves.toEqual({
      key: "ie-key",
      source: "country",
      country: "IE",
    });
  });

  it("uses the default country when the caller names none", async () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.menuKeysByCountry": "GB:gb-key,IE:ie-key",
        "app.platforms.jet.defaultCountry": "IE",
      },
    });
    expect((await resolver.resolve({ type: "menu" })).key).toBe("ie-key");
  });

  it("prefers a brand's own key over both", async () => {
    // The >6-locations case: JET issues that brand its own key.
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": "GB:gb-key" },
      connection: { metadata: { credentials: { menuKey: "brand-key" } } },
    });
    await expect(
      resolver.resolve({ type: "menu", brandId: "brand-1" }),
    ).resolves.toEqual({ key: "brand-key", source: "brand" });
  });

  it("falls through per key type — a brand can hold one key but not the other", async () => {
    const { resolver } = makeResolver({
      connection: { metadata: { credentials: { menuKey: "brand-menu-key" } } },
    });
    expect((await resolver.resolve({ type: "menu", brandId: "b1" })).source).toBe(
      "brand",
    );
    expect((await resolver.resolve({ type: "order", brandId: "b1" })).source).toBe(
      "platform",
    );
  });

  it("reports no key rather than an empty string when nothing is configured", async () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.menuApiKey": "",
        "app.platforms.jet.orderApiKey": "",
      },
    });
    await expect(resolver.resolve({ type: "menu" })).resolves.toEqual({
      key: null,
      source: "none",
    });
  });
});

describe("JetCredentialResolver — country list parsing", () => {
  it("is case-insensitive on the country code", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": "gb:gb-key" },
    });
    expect((await resolver.resolve({ type: "menu", country: "GB" })).key).toBe(
      "gb-key",
    );
  });

  it("tolerates whitespace around entries", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": " GB : gb-key , IE:ie-key " },
    });
    expect((await resolver.resolve({ type: "menu", country: "GB" })).key).toBe(
      "gb-key",
    );
  });

  it("skips a malformed entry instead of losing every other country", async () => {
    // A typo in one country's key must not take the rest down with it.
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": "broken,IE:ie-key" },
    });
    expect((await resolver.resolve({ type: "menu", country: "IE" })).key).toBe(
      "ie-key",
    );
  });

  it("keeps a key containing a colon intact", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.menuKeysByCountry": "GB:abc:def:ghi" },
    });
    expect((await resolver.resolve({ type: "menu", country: "GB" })).key).toBe(
      "abc:def:ghi",
    );
  });
});

describe("JetCredentialResolver — degradation", () => {
  it("falls back to the shared key when a brand's ciphertext cannot be read", async () => {
    // A brand whose envelope predates a key rotation should lose its own key,
    // not lose Just Eat entirely.
    const { resolver } = makeResolver({
      connection: { metadata: { credentials: { menuKey: "x" } } },
    });
    (resolver as any).crypto = {
      decrypt: () => {
        throw new Error("auth tag mismatch");
      },
    };
    await expect(resolver.resolve({ type: "menu", brandId: "b1" })).resolves.toEqual(
      { key: PLATFORM_MENU, source: "platform" },
    );
  });

  it("ignores a connection with no credentials envelope", async () => {
    const { resolver } = makeResolver({ connection: { metadata: {} } });
    expect((await resolver.resolve({ type: "menu", brandId: "b1" })).source).toBe(
      "platform",
    );
  });

  it("scopes the brand lookup to a location when one is given", async () => {
    const { resolver, findFirst } = makeResolver({ connection: { metadata: {} } });
    await resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1" });
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      brandId: "b1",
      platform: "JUST_EAT",
      locationId: "l1",
    });
  });
});

describe("JetCredentialResolver.encryptForStorage", () => {
  it("drops blank keys so a brand can hold one and share the other", async () => {
    const { resolver } = makeResolver();
    expect(resolver.encryptForStorage({ menuKey: "m", orderKey: "   " })).toEqual({
      menuKey: "m",
    });
  });
});

describe("JetCredentialResolver.configured", () => {
  it("counts a country key as configured", () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.menuApiKey": "",
        "app.platforms.jet.menuKeysByCountry": "GB:gb-key",
      },
    });
    expect(resolver.configured("menu")).toBe(true);
  });

  it("is false when neither tier has anything", () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.menuApiKey": "",
        "app.platforms.jet.menuKeysByCountry": "",
      },
    });
    expect(resolver.configured("menu")).toBe(false);
  });
});
