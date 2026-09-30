import { YangoApiError, YangoClientService } from "../yango-client.service";

// The wire format: one host for every country, claim_id in the QUERY except for
// the two methods that take it in the BODY, and two GETs among the POSTs.

const creds = { token: "tok-123" };

function mockFetch(responses: Array<{ status: number; body?: any; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  });
  return calls;
}

describe("YangoClientService", () => {
  const c = new YangoClientService();
  const realFetch = global.fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
    delete process.env.YANGO_API_BASE;
  });

  it("uses b2b.taxi.yandex.net — there is no Yango-branded host, UAE included", async () => {
    const calls = mockFetch([{ status: 200, body: { price: "10" } }]);
    await c.checkPrice(creds, { items: [], route_points: [] } as any);
    expect(calls[0]!.url).toBe("https://b2b.taxi.yandex.net/b2b/cargo/integration/v2/check-price");
  });

  it("sends a static Bearer token and Accept-Language", async () => {
    const calls = mockFetch([{ status: 200, body: {} }]);
    await c.claimInfo(creds, "claim-1");
    const h = calls[0]!.init.headers;
    expect(h.Authorization).toBe("Bearer tok-123");
    expect(h["Accept-Language"]).toBe("en");
  });

  it("create carries request_id in the query (the idempotency key)", async () => {
    const calls = mockFetch([{ status: 200, body: { id: "c1" } }]);
    await c.createClaim(creds, "req-uuid", { items: [], route_points: [] } as any);
    expect(calls[0]!.url).toMatch(/claims\/create\?request_id=req-uuid$/);
  });

  it("accept / cancel: claim_id in the query, version in the body", async () => {
    const calls = mockFetch([{ status: 200, body: {} }]);
    await c.acceptClaim(creds, "claim-1", 3);
    await c.cancelClaim(creds, "claim-1", 4, "paid");
    expect(calls[0]!.url).toMatch(/claims\/accept\?claim_id=claim-1$/);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ version: 3 });
    expect(calls[1]!.url).toMatch(/claims\/cancel\?claim_id=claim-1$/);
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ version: 4, cancel_state: "paid" });
  });

  it("performer-position and tracking-links are GET", async () => {
    const calls = mockFetch([{ status: 200, body: {} }]);
    await c.performerPosition(creds, "claim-1");
    await c.trackingLinks(creds, "claim-1");
    expect(calls.map((x) => x.init.method)).toEqual(["GET", "GET"]);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("driver-voiceforwarding takes claim_id in the BODY, not the query", async () => {
    const calls = mockFetch([{ status: 200, body: {} }]);
    await c.courierPhone(creds, "claim-1", 9001);
    expect(calls[0]!.url).toMatch(/driver-voiceforwarding$/);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ claim_id: "claim-1", point_id: 9001 });
  });

  it("tariffs sends the point as [lon, lat]", async () => {
    const calls = mockFetch([{ status: 200, body: {} }]);
    await c.tariffs(creds, { lat: 25.2, lng: 55.27 });
    expect(JSON.parse(calls[0]!.init.body).start_point).toEqual([55.27, 25.2]);
  });

  it("keeps Yango's machine error code for the caller to branch on", async () => {
    mockFetch([{ status: 409, body: { code: "old_version", message: "Old version" } }]);
    const err = await c.acceptClaim(creds, "claim-1", 1).catch((e) => e);
    expect(err).toBeInstanceOf(YangoApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("old_version");
  });

  it("names the fix on a 401 (a changed cabinet password kills the token)", async () => {
    mockFetch([{ status: 401, body: { code: "unauthorized", message: "Access denied" } }]);
    await expect(c.claimInfo(creds, "x")).rejects.toThrow(/Integration/);
  });

  it("retries a 429 once, briefly", async () => {
    const calls = mockFetch([
      { status: 429, body: { code: "too_many_requests" }, headers: { "retry-after": "0" } },
      { status: 200, body: { price: "1" } },
    ]);
    const r = await c.checkPrice(creds, {} as any);
    expect(r.price).toBe("1");
    expect(calls).toHaveLength(2);
  });

  it("bulk_info chunks at 1000 ids", async () => {
    const calls = mockFetch([{ status: 200, body: { claims: [{ id: "a" }] } }]);
    const ids = Array.from({ length: 1500 }, (_, i) => `c${i}`);
    const out = await c.bulkInfo(creds, ids);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.init.body).claim_ids).toHaveLength(1000);
    expect(JSON.parse(calls[1]!.init.body).claim_ids).toHaveLength(500);
    expect(out).toHaveLength(2);
  });
});
