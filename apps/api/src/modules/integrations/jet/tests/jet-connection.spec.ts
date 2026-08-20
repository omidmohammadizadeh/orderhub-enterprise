import { JetConnectionService } from "../jet-connection.service";

// The connect form. JET has no OAuth, so this is what an operator types in
// after their onboarding email arrives — and the same three fields HubRise's
// own Just Eat Flyt Bridge asks for, plus the routing id that bridge does not
// need because HubRise is the POS there.

function makeService(
  opts: { existing?: any; clash?: any; brand?: any; location?: any } = {},
) {
  const upsert = jest.fn(async ({ create, update }: any) => ({
    id: "conn-1",
    brandId: "brand-1",
    locationId: "location-1",
    platform: "JUST_EAT",
    status: "connected",
    ...(create ?? {}),
    ...(update ?? {}),
  }));
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest
        .fn()
        // First call is the POS-location-id clash check, second reads the
        // existing row to preserve stored keys.
        .mockImplementationOnce(async () => opts.clash ?? null)
        .mockImplementation(async () => opts.existing ?? null),
      upsert,
      update: jest.fn(async () => ({ id: "conn-1", metadata: {} })),
    },
    brand: { findFirst: jest.fn(async () => opts.brand ?? { id: "brand-1" }) },
    location: {
      findFirst: jest.fn(async () => opts.location ?? { id: "location-1" }),
    },
    order: { findFirst: jest.fn(async () => null) },
  } as any;
  const client = {
    webhookSecretConfigured: true,
    inboundApiKeyConfigured: true,
  } as any;
  // Opaque on purpose. CredentialEncryptionService returns an AES-GCM
  // envelope containing no plaintext, so the fake must too — a passthrough
  // would let "never stored in the clear" pass against a service that wrote
  // the raw key.
  const credentials = {
    encryptForStorage: jest.fn(() => ({
      v: 1,
      alg: "aes-256-gcm",
      iv: "00",
      tag: "11",
      ct: "ciphertext",
    })),
    resolve: jest.fn(async () => ({ key: "k", source: "platform" })),
  } as any;
  const activity = { record: jest.fn() } as any;
  return {
    service: new JetConnectionService(prisma, client, credentials, activity),
    prisma,
    upsert,
    credentials,
  };
}

const BASE = {
  brandId: "brand-1",
  locationId: "location-1",
  restaurantReference: "8282340",
};

describe("JetConnectionService.connect", () => {
  it("requires the Restaurant ID, which is what Just Eat actually sends you", async () => {
    const { service } = makeService();
    await expect(
      service.connect("t1", { ...BASE, restaurantReference: "  " }),
    ).rejects.toThrow(/Restaurant ID is required/i);
  });

  it("defaults the POS location id to the Restaurant ID", async () => {
    // They are the same value in the normal case — JET configures the
    // restaurant reference as the POS location id unless a partner asks
    // otherwise — so asking twice would be noise on every single connect.
    const { service, upsert } = makeService();
    await service.connect("t1", BASE);
    const create = upsert.mock.calls[0]![0].create;
    expect(create.externalStoreId).toBe("8282340");
    expect(create.metadata.restaurantReference).toBe("8282340");
    expect(create.metadata.posLocationId).toBe("8282340");
  });

  it("keeps the two ids apart when JET sends something different", async () => {
    const { service, upsert } = makeService();
    await service.connect("t1", { ...BASE, posLocationId: "POS-9" });
    const create = upsert.mock.calls[0]![0].create;
    // Orders route on this one…
    expect(create.externalStoreId).toBe("POS-9");
    // …while menus, availability and status use this one.
    expect(create.metadata.restaurantReference).toBe("8282340");
  });

  it("encrypts brand-issued keys and never stores them in the clear", async () => {
    const { service, upsert, credentials } = makeService();
    await service.connect("t1", {
      ...BASE,
      menuKey: "menu-secret",
      orderKey: "order-secret",
    });
    expect(credentials.encryptForStorage).toHaveBeenCalledWith({
      menuKey: "menu-secret",
      orderKey: "order-secret",
    });
    // What lands on the row is the encryptor's envelope, not the input.
    const metadata = upsert.mock.calls[0]![0].create.metadata;
    expect(JSON.stringify(metadata)).not.toContain("menu-secret");
    expect(JSON.stringify(metadata)).not.toContain("order-secret");
    expect(metadata.credentials).toMatchObject({ alg: "aes-256-gcm" });
  });

  it("stores no credentials envelope when the brand uses the shared keys", async () => {
    const { service, upsert } = makeService();
    await service.connect("t1", BASE);
    expect(upsert.mock.calls[0]![0].create.metadata.credentials).toBeUndefined();
  });

  it("KEEPS stored keys when the form is re-saved with the key fields blank", async () => {
    // The manage panel never renders a saved key back — it is a secret — so
    // treating blank as "clear it" would wipe a brand's keys every time
    // somebody corrected a typo in the Restaurant ID.
    const stored = { v: 1, alg: "aes-256-gcm", iv: "aa", tag: "bb", ct: "kept" };
    const { service, upsert } = makeService({
      existing: { metadata: { credentials: stored } },
    });
    await service.connect("t1", { ...BASE, restaurantReference: "9999999" });
    expect(upsert.mock.calls[0]![0].create.metadata.credentials).toEqual(stored);
  });

  it("refuses a POS location id already used by another restaurant", async () => {
    // Orders are routed by this value. A duplicate would send one restaurant's
    // orders to whichever row was found first — a live misrouting that is
    // miserable to debug.
    const { service } = makeService({
      clash: { id: "other", brandId: "b2", locationId: "l2" },
    });
    await expect(service.connect("t1", BASE)).rejects.toThrow(
      /already used by another Just Eat connection/i,
    );
  });

  it("marks the connection connected and clears any previous error", async () => {
    const { service, upsert } = makeService();
    await service.connect("t1", BASE);
    expect(upsert.mock.calls[0]![0].update.status).toBe("connected");
    expect(upsert.mock.calls[0]![0].update.lastError).toBeNull();
  });
});

describe("JetConnectionService.present", () => {
  it("never exposes the credentials envelope, only whether one exists", async () => {
    const { service, upsert } = makeService();
    upsert.mockResolvedValueOnce({
      id: "conn-1",
      brandId: "brand-1",
      locationId: "location-1",
      status: "connected",
      externalStoreId: "8282340",
      externalBrandId: null,
      metadata: {
        restaurantReference: "8282340",
        credentials: { v: 1, alg: "aes-256-gcm", iv: "aa", tag: "bb", ct: "super-secret" },
      },
    });
    const result: any = await service.connect("t1", BASE);
    expect(result.hasBrandKeys).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(result.restaurantReference).toBe("8282340");
  });
});
