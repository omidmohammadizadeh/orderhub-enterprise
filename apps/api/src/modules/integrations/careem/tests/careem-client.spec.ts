import { CareemAuthError, CareemClientService } from "../careem-client.service";
import { verifyCareemApiKey } from "../careem-webhook.controller";

// Careem POS transport + the static-key webhook auth.
//
// Both halves have a trap the spec states plainly and every comparable
// integration contradicts: the TOKEN request is multipart/form-data (everyone
// else takes x-www-form-urlencoded), and the WEBHOOKS carry no signature at
// all — just a static `x-careem-api-key`.

describe("CareemClientService — environment", () => {
  afterEach(() => {
    delete process.env.CAREEM_ENV;
    delete process.env.CAREEM_API_BASE;
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
  });

  it("defaults to staging, so a half-configured deploy can't touch real orders", () => {
    const svc = new CareemClientService();
    expect(svc.env).toBe("staging");
    expect(svc.baseUrl).toBe("https://apigateway-stg.careemdash.com/pos/api/v1");
  });

  it("uses production only when explicitly asked", () => {
    process.env.CAREEM_ENV = "production";
    const svc = new CareemClientService();
    expect(svc.env).toBe("production");
    expect(svc.baseUrl).toBe("https://apigateway.careemdash.com/pos/api/v1");
  });

  it("treats anything else as staging rather than guessing", () => {
    process.env.CAREEM_ENV = "prod"; // near-miss
    expect(new CareemClientService().env).toBe("staging");
  });

  it("reports unconfigured until both halves of the credential are present", () => {
    const svc = new CareemClientService();
    expect(svc.configured()).toBe(false);
    process.env.CAREEM_CLIENT_ID = "cid";
    expect(svc.configured()).toBe(false);
    process.env.CAREEM_CLIENT_SECRET = "csec";
    expect(svc.configured()).toBe(true);
  });
});

describe("CareemClientService — token", () => {
  const okToken = (expires_in = 3600) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ access_token: "tok_1", token_type: "Bearer", expires_in }),
  });

  beforeEach(() => {
    process.env.CAREEM_CLIENT_ID = "cid";
    process.env.CAREEM_CLIENT_SECRET = "csec";
  });
  afterEach(() => {
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
    jest.restoreAllMocks();
  });

  it("posts multipart/form-data with the only grant type and scope Careem accepts", async () => {
    // Sending x-www-form-urlencoded here returns a bare 400 with nothing to go
    // on, which is why this is pinned rather than left to the reader.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken() as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok_1");

    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain("/token");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("grant_type")).toBe("client_credentials");
    expect(init.body.get("scope")).toBe("pos");
    expect(init.body.get("client_id")).toBe("cid");
    // FormData sets its own multipart boundary — setting Content-Type by hand
    // produces a boundary mismatch and an unparseable request.
    expect(init.headers?.["Content-Type"]).toBeUndefined();
  });

  it("caches the token instead of re-authenticating per call", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken() as any);
    const svc = new CareemClientService();
    await svc.accessToken();
    await svc.accessToken();
    await svc.accessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes ONE request when several callers race a cold cache", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken() as any);
    const svc = new CareemClientService();
    await Promise.all([svc.accessToken(), svc.accessToken(), svc.accessToken()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates when the token is nearly expired", async () => {
    // A token valid for 30s is inside the 60s skew, so it must never be
    // handed out — a request could start valid and finish expired.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken(30) as any);
    const svc = new CareemClientService();
    await svc.accessToken();
    await svc.accessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to authenticate when unconfigured", async () => {
    delete process.env.CAREEM_CLIENT_ID;
    await expect(new CareemClientService().accessToken()).rejects.toThrow(
      /not configured/i,
    );
  });

  it("retries a 401 exactly once with a fresh token", async () => {
    // Careem's clock drifting past our skew shouldn't fail an order accept.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(okToken() as any) // initial token
      .mockResolvedValueOnce({ status: 401, ok: false, text: async () => "" } as any)
      .mockResolvedValueOnce(okToken() as any) // forced refresh
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 1 }),
      } as any);
    const svc = new CareemClientService();
    await expect(svc.request("/orders/1", { method: "GET" })).resolves.toEqual({
      id: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not loop on a persistent 401", async () => {
    jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(okToken() as any)
      .mockResolvedValueOnce({ status: 401, ok: false, text: async () => "" } as any)
      .mockResolvedValueOnce(okToken() as any)
      .mockResolvedValueOnce({
        status: 401,
        ok: false,
        text: async () => "still unauthorised",
      } as any);
    const svc = new CareemClientService();
    await expect(svc.request("/orders/1")).rejects.toThrow(/401/);
  });
});

describe("verifyCareemApiKey", () => {
  it("accepts the configured key", () => {
    expect(verifyCareemApiKey("a12345f-1337", "a12345f-1337")).toBe(true);
  });

  it("rejects a wrong key, a missing header and an unconfigured server", () => {
    expect(verifyCareemApiKey("wrong-key-13", "a12345f-1337")).toBe(false);
    expect(verifyCareemApiKey(undefined, "a12345f-1337")).toBe(false);
    // Never let an unset env var mean "everything is authentic" — this
    // endpoint is public and posting an order to it would otherwise be
    // enough to put food on a real kitchen's screen.
    expect(verifyCareemApiKey("anything", undefined)).toBe(false);
    expect(verifyCareemApiKey("", "")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    // timingSafeEqual throws on unequal lengths, and an exception on a public
    // endpoint anyone can post to is a denial of service.
    expect(() => verifyCareemApiKey("short", "a-much-longer-key")).not.toThrow();
    expect(verifyCareemApiKey("short", "a-much-longer-key")).toBe(false);
  });

  it("tolerates surrounding whitespace from header handling", () => {
    expect(verifyCareemApiKey("  a12345f-1337  ", "a12345f-1337")).toBe(true);
  });
});

describe("CareemAuthError", () => {
  beforeEach(() => {
    process.env.CAREEM_CLIENT_ID = "cid";
    process.env.CAREEM_CLIENT_SECRET = "csec";
  });
  afterEach(() => {
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
    delete process.env.CAREEM_TOKEN_URL;
    jest.restoreAllMocks();
  });

  it("carries Careem's own words rather than a generic message", async () => {
    // Their errors name the actual problem — "clients not found for
    // client_id=…" means the webhook isn't configured for the environment,
    // per their FAQ. Generalising that to "could not authenticate" turns a
    // five-minute fix into a support thread.
    const said = JSON.stringify({
      message: "clients not found for client_id=abc",
      code: "NOT_FOUND_ERROR",
    });
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => said,
    } as any);

    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toMatchObject({
      name: "CareemAuthError",
      status: 404,
      body: said,
    });
  });

  it("asks the IDENTITY provider for tokens, not the gateway", () => {
    // The spec contradicts itself: /token is under `paths` (the gateway) while
    // securitySchemes gives the identity host. Only one works —
    //   POST {gateway}/token           → 404 Symfony NotFoundHttpException
    //   POST identity.careem.com/token → 401 {"error":"invalid_client"}
    // — and a 401 invalid_client is an OAuth2 server correctly rejecting bad
    // credentials, i.e. the endpoint is real.
    const svc = new CareemClientService();
    expect(svc.tokenUrl).toBe("https://identity.careem.com/token");
    expect(svc.tokenUrl).not.toContain("careemdash");
  });

  it("uses one identity host for both environments", () => {
    // The client_id decides which environment the token is for, so this is
    // deliberately NOT derived from CAREEM_ENV.
    process.env.CAREEM_ENV = "production";
    expect(new CareemClientService().tokenUrl).toBe(
      "https://identity.careem.com/token",
    );
    delete process.env.CAREEM_ENV;
  });

  it("still allows an override", () => {
    process.env.CAREEM_TOKEN_URL = "https://identity-test.example/token";
    expect(new CareemClientService().tokenUrl).toBe(
      "https://identity-test.example/token",
    );
  });
});
