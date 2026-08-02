import { createCorsOriginCheck } from "../cors.config";

// The case that actually broke production: a POST from a brand's custom
// domain. The storefront loaded fine (same-origin GETs carry no Origin) and
// then "Start group order" returned 500 "Internal server error", because the
// old callback threw for any origin not in the env allowlist — and browsers
// attach Origin to every non-GET request, even same-origin ones.

const decide = (
  origin: ReturnType<typeof createCorsOriginCheck>["origin"],
  value: string | undefined,
): Promise<{ err: Error | null; allow?: boolean }> =>
  new Promise((resolve) =>
    origin(value, (err, allow) => resolve({ err, allow })),
  );

describe("CORS origin check", () => {
  const allowedOrigins = ["https://www.orderhubsolutions.com"];

  it("allows a request with no Origin (same-origin GET, curl, mobile)", async () => {
    const { origin } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => [],
    });
    await expect(decide(origin, undefined)).resolves.toEqual({
      err: null,
      allow: true,
    });
  });

  it("allows a configured origin", async () => {
    const { origin } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => [],
    });
    await expect(
      decide(origin, "https://www.orderhubsolutions.com"),
    ).resolves.toEqual({ err: null, allow: true });
  });

  it("allows a brand custom domain", async () => {
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => ["pizzaunopelton.co.uk"],
    });
    await warm();
    await expect(decide(origin, "https://pizzaunopelton.co.uk")).resolves.toEqual(
      { err: null, allow: true },
    );
  });

  it("matches custom domains case-insensitively and ignores stray whitespace", async () => {
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => ["  PizzaUnoPelton.co.uk "],
    });
    await warm();
    await expect(decide(origin, "https://pizzaunopelton.co.uk")).resolves.toEqual(
      { err: null, allow: true },
    );
  });

  it("treats www. and the apex as the same shop, whichever way it was stored", async () => {
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => ["pizzaunopelton.co.uk"],
    });
    await warm();
    await expect(
      decide(origin, "https://www.pizzaunopelton.co.uk"),
    ).resolves.toEqual({ err: null, allow: true });

    const stored = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => ["www.pizzaunopelton.co.uk"],
    });
    await stored.warm();
    await expect(
      decide(stored.origin, "https://pizzaunopelton.co.uk"),
    ).resolves.toEqual({ err: null, allow: true });
  });

  it("NEVER throws for a refused origin — throwing is what produced the 500", async () => {
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => [],
    });
    await warm();
    const result = await decide(origin, "https://evil.example.com");
    expect(result.err).toBeNull();
    expect(result.allow).toBe(false);
  });

  it("refuses a malformed Origin without throwing", async () => {
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => [],
    });
    await warm();
    await expect(decide(origin, "not-a-url")).resolves.toEqual({
      err: null,
      allow: false,
    });
  });

  it("reloads once the cache is stale so a newly connected domain works", async () => {
    let connected: string[] = [];
    let clock = 1_000;
    const { origin, warm } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => connected,
      ttlMs: 60_000,
      now: () => clock,
    });
    await warm();

    // Not connected yet → refused, and no reload attempt (cache is fresh).
    await expect(decide(origin, "https://newshop.co.uk")).resolves.toEqual({
      err: null,
      allow: false,
    });

    connected = ["newshop.co.uk"];
    clock += 120_000; // cache now stale
    await expect(decide(origin, "https://newshop.co.uk")).resolves.toEqual({
      err: null,
      allow: true,
    });
  });

  it("refuses rather than opening up when the reload fails", async () => {
    let clock = 1_000;
    const { origin } = createCorsOriginCheck({
      allowedOrigins,
      loadCustomDomains: async () => {
        throw new Error("database down");
      },
      ttlMs: 60_000,
      now: () => clock,
    });
    clock += 120_000;
    await expect(decide(origin, "https://someshop.co.uk")).resolves.toEqual({
      err: null,
      allow: false,
    });
  });
});
