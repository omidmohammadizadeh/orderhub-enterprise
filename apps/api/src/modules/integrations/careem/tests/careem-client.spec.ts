import {
  AUTH_VARIANTS,
  CareemAuthError,
  describeCareemError,
  CareemClientService,
  isClientAuthFailure,
} from "../careem-client.service";
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

  it("leads with the Identity guide's exact S2S curl", async () => {
    // Careem has two documents that disagree. The POS spec says
    // multipart/form-data with scope=pos required; the Identity guide — which
    // is the document that actually describes THIS token endpoint — shows
    // x-www-form-urlencoded with exactly three fields and NO scope. The POS
    // spec was already wrong about the endpoint's URL, so the Identity guide
    // goes first.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken() as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok_1");

    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    // Staging is the default environment, and staging has its own identity
    // host — see "token host per environment" below.
    expect(url).toBe("https://identity.qa.careem-engineering.com/token");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get("grant_type")).toBe("client_credentials");
    expect(sent.get("client_id")).toBe("cid");
    expect(sent.get("client_secret")).toBe("csec");
    // The whole point: no scope.
    expect(sent.get("scope")).toBeNull();
  });

  it("still offers the POS spec's shape as a fallback", async () => {
    const rejected = {
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_client"}',
    };
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(okToken() as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok_1");

    const second = fetchMock.mock.calls[1]![1] as any;
    expect(new URLSearchParams(second.body as string).get("scope")).toBe("pos");
  });

  it("sends multipart only after both urlencoded shapes fail", async () => {
    const rejected = {
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_client"}',
    };
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(okToken() as any);
    const svc = new CareemClientService();
    await svc.accessToken();
    const third = fetchMock.mock.calls[2]![1] as any;
    expect(third.body).toBeInstanceOf(FormData);
    // FormData sets its own boundary — setting Content-Type by hand produces a
    // boundary mismatch and an unparseable request.
    expect(third.headers?.["Content-Type"]).toBeUndefined();
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
    // /token sits under `paths` (the gateway) but carries its own `servers`
    // block naming the identity hosts. Only the latter works —
    //   POST {gateway}/token  → 404 Symfony NotFoundHttpException
    //   POST {identity}/token → speaks OAuth2
    const svc = new CareemClientService();
    expect(svc.tokenUrl).toContain("/token");
    expect(svc.tokenUrl).not.toContain("careemdash");
  });

  it("uses the environment's own identity host", () => {
    // This test previously asserted the opposite — that ONE host served both
    // environments and the client_id decided which. Careem's 2.1.0 spec gives
    // /token a `servers` block with a distinct staging host, and presenting
    // staging credentials to the production server is answered with "Bad
    // credentials". The old assumption was the bug, and this test pinned it.
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

describe("client-authentication variants", () => {
  beforeEach(() => {
    process.env.CAREEM_CLIENT_ID = "cid";
    process.env.CAREEM_CLIENT_SECRET = "csec";
  });
  afterEach(() => {
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
    jest.restoreAllMocks();
  });

  const rejected = {
    ok: false,
    status: 401,
    text: async () =>
      JSON.stringify({ error: "invalid_client", error_description: "Bad client credentials" }),
  };
  const accepted = {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
  };

  it("omits client_id from the body when using HTTP Basic", async () => {
    // Sending it both ways is how you get "invalid_client" from a server that
    // would otherwise have accepted the header.
    const rejected = {
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_client"}',
    };
    const fetchMock = jest.spyOn(global, "fetch" as any);
    for (let i = 0; i < 3; i++) fetchMock.mockResolvedValueOnce(rejected as any);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
    } as any);

    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok");
    const fourth = fetchMock.mock.calls[3]![1] as any;
    expect(fourth.headers.Authorization).toMatch(/^Basic /);
    expect(String(fourth.body)).not.toContain("client_id");
  });

  it("falls back to HTTP Basic when the body form is rejected", async () => {
    // invalid_client is RFC 6749's error for "client authentication failed",
    // and the usual cause with good credentials is that the server wanted the
    // other style. Careem documents the body form — and their spec was already
    // wrong about the token URL.
    const fetchMock = jest.spyOn(global, "fetch" as any);
    for (let i = 0; i < 3; i++) fetchMock.mockResolvedValueOnce(rejected as any);
    fetchMock.mockResolvedValueOnce(accepted as any);

    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok");

    const winning = fetchMock.mock.calls.at(-1)![1] as any;
    expect(winning.headers.Authorization).toMatch(/^Basic /);
    // client_id must NOT also be in the body when it's in the header.
    expect(String(winning.body)).not.toContain("client_id");
  });

  it("remembers the winning style instead of re-walking the list", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(accepted as any)
      .mockResolvedValue(accepted as any);

    const svc = new CareemClientService();
    await svc.accessToken();
    const afterFirst = fetchMock.mock.calls.length;
    await svc.accessToken(true); // force past the cache
    expect(fetchMock.mock.calls.length).toBe(afterFirst + 1);
  });

  it("does not try other styles for an error that isn't about client auth", () => {
    // A 404 or a 500 means something else is wrong; retrying four ways just
    // makes noise and four times the load.
    expect(isClientAuthFailure(401, '{"error":"invalid_client"}')).toBe(true);
    expect(isClientAuthFailure(400, "unauthorized_client")).toBe(true);
    expect(isClientAuthFailure(404, "NotFoundHttpException")).toBe(false);
    expect(isClientAuthFailure(500, "internal")).toBe(false);
    expect(isClientAuthFailure(401, "some other problem")).toBe(false);
  });

  it("stops after one attempt on a non-auth error", async () => {
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "NotFoundHttpException",
    } as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toBeInstanceOf(CareemAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("probes every style and reports each result", async () => {
    jest.spyOn(global, "fetch" as any).mockResolvedValue(rejected as any);
    const results = await new CareemClientService().diagnoseAuth();
    expect(results.map((r) => r.variant)).toEqual([...AUTH_VARIANTS]);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });
});

describe("required headers", () => {
  beforeEach(() => {
    process.env.CAREEM_CLIENT_ID = "cid";
    process.env.CAREEM_CLIENT_SECRET = "csec";
  });
  afterEach(() => {
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
    jest.restoreAllMocks();
  });

  const okToken = {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
  };

  it("sends User-Agent, which Careem lists as required on every endpoint", async () => {
    // Node's fetch doesn't reliably send one, and a gateway that rejects an
    // absent User-Agent fails in a way that looks nothing like a missing
    // header.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(okToken as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "{}",
      } as any);

    await new CareemClientService().request("/brands");
    const apiCall = fetchMock.mock.calls[1]![1] as any;
    expect(apiCall.headers["User-Agent"]).toMatch(/OrderHub/);
  });

  it("sets it on the token request too", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue(okToken as any);
    await new CareemClientService().accessToken();
    const tokenCall = fetchMock.mock.calls[0]![1] as any;
    expect(tokenCall.headers["User-Agent"]).toMatch(/OrderHub/);
  });

  it("passes Brand-Id and Branch-Id when given", async () => {
    // Careem scopes branch, catalog and order endpoints by header rather than
    // by path — omitting them is a 400 that reads like a bad body.
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(okToken as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" } as any);

    await new CareemClientService().request("/catalogs", {
      method: "PUT",
      brandId: "brand-1",
      branchId: "branch-1",
      body: {},
    });
    const apiCall = fetchMock.mock.calls[1]![1] as any;
    expect(apiCall.headers["Brand-Id"]).toBe("brand-1");
    expect(apiCall.headers["Branch-Id"]).toBe("branch-1");
  });

  it("omits them entirely when not given, rather than sending empty strings", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(okToken as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" } as any);
    await new CareemClientService().request("/brands");
    const apiCall = fetchMock.mock.calls[1]![1] as any;
    expect(apiCall.headers["Brand-Id"]).toBeUndefined();
    expect(apiCall.headers["Branch-Id"]).toBeUndefined();
  });
});

describe("rate-limit protection", () => {
  // Careem's docs: "do not try to request a new token every time you do an API
  // request. This might potentially lead to unneeded rate-limiting or even IP
  // block and might require manual intervention." We tripped exactly that — the
  // diagnostics page polled a FORCED token refresh every 30s, and with the
  // variant fallback that was up to six requests per poll.
  beforeEach(() => {
    process.env.CAREEM_CLIENT_ID = "cid";
    process.env.CAREEM_CLIENT_SECRET = "csec";
  });
  afterEach(() => {
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
    jest.restoreAllMocks();
  });

  const rejected = {
    ok: false,
    status: 401,
    text: async () => '{"error":"invalid_client"}',
  };
  const throttled = {
    ok: false,
    status: 429,
    text: async () => "<html>Access denied … Cloudflare</html>",
  };

  it("stops asking after a failure, even when forced", async () => {
    // `force` exists for a 401 mid-request. It must not become a way to
    // hammer an endpoint that is already refusing us.
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue(rejected as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toBeInstanceOf(CareemAuthError);
    const afterFirst = fetchMock.mock.calls.length;

    await expect(svc.accessToken()).rejects.toBeInstanceOf(CareemAuthError);
    await expect(svc.accessToken(true)).rejects.toBeInstanceOf(CareemAuthError);
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    expect(svc.cooldownSeconds).toBeGreaterThan(0);
  });

  it("backs off much harder on a 429 than on a rejection", async () => {
    jest.spyOn(global, "fetch" as any).mockResolvedValue(throttled as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toBeInstanceOf(CareemAuthError);
    // 30 minutes vs 5 — at 429 the endpoint is already telling us to stop.
    expect(svc.cooldownSeconds).toBeGreaterThan(20 * 60);
  });

  it("does not walk the variant list while being rate limited", async () => {
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue(throttled as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toBeInstanceOf(CareemAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the probe at the first 429 instead of firing all six", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValue(throttled as any);
    const results = await new CareemClientService().diagnoseAuth();
    expect(results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets an operator clear the cooldown deliberately", async () => {
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue(rejected as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).rejects.toThrow();
    const before = fetchMock.mock.calls.length;
    svc.resetCooldown();
    expect(svc.cooldownSeconds).toBe(0);
    await expect(svc.accessToken()).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("clears the cooldown once a token finally succeeds", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce(rejected as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
      } as any);
    const svc = new CareemClientService();
    await expect(svc.accessToken()).resolves.toBe("tok");
    expect(svc.cooldownSeconds).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
  });
});

// The sandbox has to be complete or it is worse than nothing: pointing only
// CAREEM_API_BASE at the mock left the token request going to Careem's real
// identity provider — the one request we have no credentials for — so every
// call died at step one without ever reaching the mock.
describe("CareemClientService — sandbox wiring", () => {
  const svc = () => new CareemClientService();

  beforeEach(() => {
    process.env.CAREEM_SANDBOX = "true";
    process.env.CAREEM_ENV = "staging";
    process.env.CAREEM_API_BASE = "https://us.example.com/api/v1/careem-mock";
    delete process.env.CAREEM_TOKEN_URL;
    delete process.env.CAREEM_CLIENT_ID;
    delete process.env.CAREEM_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.CAREEM_SANDBOX;
    delete process.env.CAREEM_API_BASE;
  });

  it("asks the sandbox for the token, not Careem", () => {
    expect(svc().tokenUrl).toBe("https://us.example.com/api/v1/careem-mock/token");
  });

  it("needs no Careem credentials — that is the whole point", () => {
    expect(svc().configured()).toBe(true);
  });

  it("still honours an explicit CAREEM_TOKEN_URL", () => {
    process.env.CAREEM_TOKEN_URL = "https://elsewhere.test/token";
    expect(svc().tokenUrl).toBe("https://elsewhere.test/token");
  });

  it("goes back to Careem's identity provider once the sandbox is off", () => {
    process.env.CAREEM_SANDBOX = "false";
    expect(svc().tokenUrl).toBe(
      "https://identity.qa.careem-engineering.com/token",
    );
    expect(svc().configured()).toBe(false);
  });

  it("refuses to sandbox against Careem's production", () => {
    process.env.CAREEM_ENV = "production";
    expect(svc().tokenUrl).toBe("https://identity.careem.com/token");
    process.env.CAREEM_ENV = "staging";
  });
});

// Careem's errors are the useful part of a failure — several map straight to a
// fix in their own FAQ. Collapsing them to "request failed (400)" throws away
// the only thing worth reading, which is what step 3 of the sandbox showed.
describe("describeCareemError", () => {
  it("pulls the field and the reason out of a validation error", () => {
    // Their FAQ's own example: the wall every partner hits first.
    const body = JSON.stringify({
      message: "Validation Error",
      code: "VALIDATION_ERROR",
      error_type: "ValidationError",
      errors: [{ field: "branch_id", errors: [{ message: "branch_id is not mapped" }] }],
    });
    expect(describeCareemError(body)).toBe(
      "Validation Error — branch_id: branch_id is not mapped",
    );
  });

  it("collapses the same message repeated per offending row", () => {
    // Their blank-name example repeats "Name cannot be blank!" once per entity.
    const body = JSON.stringify({
      message: "Validation Error",
      errors: [
        {
          field: "Name",
          errors: [
            { message: "Name cannot be blank!" },
            { message: "Name cannot be blank!" },
            { message: "Name cannot be blank!" },
          ],
        },
      ],
    });
    expect(describeCareemError(body)).toBe(
      "Validation Error — Name: Name cannot be blank!",
    );
  });

  it("reads a forbidden error's reason", () => {
    const body = JSON.stringify({
      message: "Forbidden Error",
      errors: [{ reason: "Catalog cannot be reset for a branch with catalog creation in progress." }],
    });
    expect(describeCareemError(body)).toContain("catalog creation in progress");
  });

  it("keeps a message that has no nested errors", () => {
    expect(
      describeCareemError(JSON.stringify({ message: "Api deprecated Error", errors: null })),
    ).toBe("Api deprecated Error");
  });

  it("falls back to the raw text when it isn't their JSON", () => {
    expect(describeCareemError("<html>502 Bad Gateway</html>")).toContain("502");
  });

  it("says something for an empty body", () => {
    expect(describeCareemError("")).toBe("(empty response)");
  });
});

// The identity provider is per environment.
//
// Careem's POS API 2.1.0 spec gives /token its own `servers` block, separate
// from the gateway's: identity.careem.com for production,
// identity.qa.careem-engineering.com for staging. We used the production host
// for both, so staging credentials were presented to the production identity
// server, which answered "Bad credentials" — true of that host, and utterly
// misleading about the credentials themselves.
describe("CareemClientService — token host per environment", () => {
  const svc = () => Object.create(CareemClientService.prototype) as any;
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("uses the STAGING identity host when CAREEM_ENV is not production", () => {
    process.env.CAREEM_ENV = "staging";
    delete process.env.CAREEM_TOKEN_URL;
    delete process.env.CAREEM_SANDBOX;
    expect(svc().tokenUrl).toBe(
      "https://identity.qa.careem-engineering.com/token",
    );
  });

  it("uses the PRODUCTION identity host when CAREEM_ENV=production", () => {
    process.env.CAREEM_ENV = "production";
    delete process.env.CAREEM_TOKEN_URL;
    delete process.env.CAREEM_SANDBOX;
    expect(svc().tokenUrl).toBe("https://identity.careem.com/token");
  });

  it("treats an unset CAREEM_ENV as staging, not production", () => {
    // Failing open to production here is how a test client ends up
    // authenticating against the live identity server.
    delete process.env.CAREEM_ENV;
    delete process.env.CAREEM_TOKEN_URL;
    delete process.env.CAREEM_SANDBOX;
    expect(svc().tokenUrl).toBe(
      "https://identity.qa.careem-engineering.com/token",
    );
  });

  it("still lets CAREEM_TOKEN_URL override either host", () => {
    process.env.CAREEM_ENV = "staging";
    process.env.CAREEM_TOKEN_URL = "https://example.test/token";
    expect(svc().tokenUrl).toBe("https://example.test/token");
  });
});
