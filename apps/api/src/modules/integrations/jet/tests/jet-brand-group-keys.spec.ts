import { JetCredentialResolver } from "../jet-credential.resolver";

// SHARED KEYS FOR A BRAND THAT SPANS MANY SHOPS.
//
// Monster Burgerz, Greek Gyros and Korean Fried Chicken each hold ONE key from
// Just Eat (the >6-locations case), but every shop is its own Brand row —
// "MONSTER BURGERZ-HADDON STREET", "MONSTER BURGERZ-PELTON" — and the brand
// tier reads the key off that brand+location's own connection. So the same key
// had to be pasted onto twenty-odd connections by hand, and a rotation means
// pasting it twenty times again.
//
// A GROUP tier fixes that: the key lives in Render once, keyed by a group
// name, and a connection opts in by naming the group.
//
// THE SAFETY PROPERTY, which matters more than the feature: this is strictly
// additive. The group tier sits BELOW the existing brand tier and only fires
// when a connection explicitly names a group. A live connection — whether it
// has pasted keys or relies on the shared country key — resolves exactly as it
// did before. The first describe block exists to pin that, and must keep
// passing unchanged.

const PLATFORM_MENU = "platform-menu-key";
const PLATFORM_ORDER = "platform-order-key";

function makeResolver(
  opts: { config?: Record<string, string>; connection?: { metadata: any } | null } = {},
) {
  const values: Record<string, string> = {
    "app.platforms.jet.menuApiKey": PLATFORM_MENU,
    "app.platforms.jet.orderApiKey": PLATFORM_ORDER,
    "app.platforms.jet.menuKeysByCountry": "",
    "app.platforms.jet.orderKeysByCountry": "",
    "app.platforms.jet.brandMenuKeys": "",
    "app.platforms.jet.brandOrderKeys": "",
    "app.platforms.jet.defaultCountry": "GB",
    ...(opts.config ?? {}),
  };
  const config = { get: (k: string) => values[k] ?? "" } as any;
  const findFirst = jest.fn(async () => opts.connection ?? null);
  const prisma = { brandPlatformConnection: { findFirst } } as any;
  const crypto = {
    encrypt: (r: Record<string, unknown>) => r,
    decrypt: (r: Record<string, unknown>) => r,
  } as any;
  return { resolver: new JetCredentialResolver(config, prisma, crypto), findFirst };
}

const GROUPS =
  "monster-burgerz:mb-menu-key,greek-gyros:gg-menu-key,korean-fried-chicken:kfc-menu-key";

describe("Live connections keep resolving exactly as they did", () => {
  it("a connection with its own pasted keys still uses them", async () => {
    // The brand tier must stay FIRST. A shop that was given its own key keeps
    // using it even once a group key exists for the same brand.
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.brandMenuKeys": GROUPS },
      connection: {
        metadata: {
          brandKeyGroup: "monster-burgerz",
          credentials: { menuKey: "this-shops-own-key" },
        },
      },
    });

    await expect(
      resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1" }),
    ).resolves.toEqual({ key: "this-shops-own-key", source: "brand" });
  });

  it("a connection with no keys and no group still gets the country key", async () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.menuKeysByCountry": "GB:gb-menu-key",
        "app.platforms.jet.brandMenuKeys": GROUPS,
      },
      connection: { metadata: {} },
    });

    await expect(
      resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1", country: "GB" }),
    ).resolves.toEqual({ key: "gb-menu-key", source: "country", country: "GB" });
  });

  it("falls through to the platform key when there is nothing else", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.brandMenuKeys": GROUPS },
      connection: { metadata: {} },
    });

    await expect(resolver.resolve({ type: "menu", brandId: "b1" })).resolves.toEqual({
      key: PLATFORM_MENU,
      source: "platform",
    });
  });

  it("changes nothing when no group keys are configured at all", async () => {
    // Before the env vars are set — i.e. the moment this ships — every
    // resolution must be identical to today's.
    const { resolver } = makeResolver({
      connection: { metadata: { brandKeyGroup: "monster-burgerz" } },
    });

    await expect(
      resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1" }),
    ).resolves.toEqual({ key: PLATFORM_MENU, source: "platform" });
  });
});

describe("Opting a connection into its brand's shared key", () => {
  it("uses the group key when the connection names a group", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.brandMenuKeys": GROUPS },
      connection: { metadata: { brandKeyGroup: "monster-burgerz" } },
    });

    await expect(
      resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1" }),
    ).resolves.toEqual({ key: "mb-menu-key", source: "brandGroup", group: "monster-burgerz" });
  });

  it("gives each brand its own key", async () => {
    const forGroup = async (group: string) => {
      const { resolver } = makeResolver({
        config: { "app.platforms.jet.brandMenuKeys": GROUPS },
        connection: { metadata: { brandKeyGroup: group } },
      });
      return (await resolver.resolve({ type: "menu", brandId: "b", locationId: "l" })).key;
    };

    expect(await forGroup("greek-gyros")).toBe("gg-menu-key");
    expect(await forGroup("korean-fried-chicken")).toBe("kfc-menu-key");
  });

  it("matches the group name whatever case or spacing it was saved in", async () => {
    const { resolver } = makeResolver({
      config: { "app.platforms.jet.brandMenuKeys": GROUPS },
      connection: { metadata: { brandKeyGroup: "  Monster-Burgerz " } },
    });

    expect(
      (await resolver.resolve({ type: "menu", brandId: "b1", locationId: "l1" })).key,
    ).toBe("mb-menu-key");
  });

  it("keeps menu and order group keys apart", async () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.brandMenuKeys": GROUPS,
        "app.platforms.jet.brandOrderKeys": "monster-burgerz:mb-order-key",
      },
      connection: { metadata: { brandKeyGroup: "monster-burgerz" } },
    });

    expect((await resolver.resolve({ type: "menu", brandId: "b" })).key).toBe("mb-menu-key");
    expect((await resolver.resolve({ type: "order", brandId: "b" })).key).toBe("mb-order-key");
  });

  it("falls through when the named group has no key of that type", async () => {
    // Monster Burgerz has a menu key but uses the shared order key. The order
    // ack must still work rather than failing because the group was named.
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.brandMenuKeys": GROUPS,
        "app.platforms.jet.orderKeysByCountry": "GB:gb-order-key",
      },
      connection: { metadata: { brandKeyGroup: "monster-burgerz" } },
    });

    await expect(
      resolver.resolve({ type: "order", brandId: "b", country: "GB" }),
    ).resolves.toEqual({ key: "gb-order-key", source: "country", country: "GB" });
  });

  it("falls through when the connection names a group nobody configured", async () => {
    // A typo in the group name must not take the shop off Just Eat.
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.brandMenuKeys": GROUPS,
        "app.platforms.jet.menuKeysByCountry": "GB:gb-menu-key",
      },
      connection: { metadata: { brandKeyGroup: "monstr-burgerz" } },
    });

    await expect(
      resolver.resolve({ type: "menu", brandId: "b", country: "GB" }),
    ).resolves.toEqual({ key: "gb-menu-key", source: "country", country: "GB" });
  });
});

describe("Listing the configured groups for the UI", () => {
  it("names the groups without ever exposing a key", async () => {
    const { resolver } = makeResolver({
      config: {
        "app.platforms.jet.brandMenuKeys": GROUPS,
        "app.platforms.jet.brandOrderKeys": "monster-burgerz:mb-order-key,pizza-co:pc-order-key",
      },
    });

    const groups = resolver.brandKeyGroups();

    expect(groups.map((g) => g.name)).toEqual([
      "greek-gyros",
      "korean-fried-chicken",
      "monster-burgerz",
      "pizza-co",
    ]);
    expect(JSON.stringify(groups)).not.toContain("mb-menu-key");
    expect(groups.find((g) => g.name === "monster-burgerz")).toEqual({
      name: "monster-burgerz",
      hasMenuKey: true,
      hasOrderKey: true,
    });
    expect(groups.find((g) => g.name === "pizza-co")).toEqual({
      name: "pizza-co",
      hasMenuKey: false,
      hasOrderKey: true,
    });
  });

  it("returns nothing when no groups are configured", async () => {
    const { resolver } = makeResolver();
    expect(resolver.brandKeyGroups()).toEqual([]);
  });
});

// ── Saving the choice on a connection ────────────────────────────────────
import { JetConnectionService } from "../jet-connection.service";

function makeConnections(existingMetadata: any = null) {
  const upsert = jest.fn(async ({ create }: any) => ({
    id: "conn-1",
    ...create,
    updatedAt: new Date(),
  }));
  const prisma: any = {
    brand: { findFirst: async () => ({ id: "b1", name: "MONSTER BURGERZ-HADDON STREET" }) },
    location: { findFirst: async () => ({ id: "l1", country: "GB" }) },
    brandPlatformConnection: {
      // Two different queries land here: the duplicate-POS-id check (which
      // excludes this brand+location) and the read of our own row. Only the
      // second should find anything, or every save looks like a clash.
      findFirst: jest.fn(async ({ where }: any) =>
        where?.brandId === "b1" && where?.locationId === "l1" && existingMetadata
          ? { id: "conn-1", metadata: existingMetadata }
          : null,
      ),
      upsert,
    },
  };
  const credentials = {
    encryptForStorage: (k: any) => ({ enc: k }),
  } as any;
  const svc = new JetConnectionService(prisma, credentials, { record: jest.fn() } as any);
  return { svc, upsert };
}

describe("Choosing the shared key on a connection", () => {
  const BODY = {
    brandId: "b1",
    locationId: "l1",
    restaurantReference: "447417",
  };

  it("saves the chosen group", async () => {
    const { svc, upsert } = makeConnections();

    await svc.connect("t1", { ...BODY, brandKeyGroup: "monster-burgerz" });

    expect(upsert.mock.calls[0][0].create.metadata.brandKeyGroup).toBe("monster-burgerz");
  });

  it("clears it when the operator unticks", async () => {
    const { svc, upsert } = makeConnections({ brandKeyGroup: "monster-burgerz" });

    await svc.connect("t1", { ...BODY, brandKeyGroup: "" });

    expect(upsert.mock.calls[0][0].create.metadata.brandKeyGroup).toBeUndefined();
  });

  it("KEEPS the existing choice when the field is not sent at all", async () => {
    // An older dashboard, or a save that only corrects the Restaurant ID,
    // must not silently drop a live shop's key choice.
    const { svc, upsert } = makeConnections({ brandKeyGroup: "greek-gyros" });

    await svc.connect("t1", BODY);

    expect(upsert.mock.calls[0][0].create.metadata.brandKeyGroup).toBe("greek-gyros");
  });

  it("leaves a connection that never had one without one", async () => {
    const { svc, upsert } = makeConnections({});

    await svc.connect("t1", BODY);

    expect(upsert.mock.calls[0][0].create.metadata.brandKeyGroup).toBeUndefined();
  });
});
