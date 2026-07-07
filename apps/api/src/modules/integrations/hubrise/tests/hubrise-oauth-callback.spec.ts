import { HubRiseOauthService } from "../hubrise-oauth.service";

// HubRise callback registration must hit POST /callback (singular) with a
// NESTED resource→[event] map — not the POST /webhooks + dotted array the
// first cut sent (that 404'd and rolled the whole connect back, forcing
// operators to the manual terminal flow). And registration must be
// NON-FATAL: the access token is what removes the terminal step, so a
// callback hiccup must never lose it.

const CONFIG: Record<string, string> = {
  "app.platforms.hubrise.appId": "client-abc",
  "app.platforms.hubrise.appSecret": "secret-xyz",
  "app.platforms.hubrise.baseUrl": "https://api.hubrise.com/v1",
  "app.platforms.hubrise.oauthTokenUrl": "https://manager.hubrise.com/oauth2/v1/token",
  "app.platforms.hubrise.redirectUri": "https://api.example.com/api/v1/integrations/hubrise/callback",
  "app.apiUrl": "https://api.example.com",
};

function makeService(fetchImpl: jest.Mock) {
  (globalThis as any).fetch = fetchImpl;
  const prisma = {
    location: { update: jest.fn(async () => ({})) },
  } as any;
  const jwt = { verify: jest.fn(() => ({ tenantId: "T1", locationId: "L1", userId: "U1", nonce: "n" })) } as any;
  const config = { get: (k: string) => CONFIG[k] } as any;
  const enc = { encrypt: (o: any) => ({ enc: true, ...o }) } as any;
  const svc = new HubRiseOauthService(prisma, jwt, config, enc);
  return { svc, prisma };
}

const tokenOk = () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "ohr_tok",
      account_id: "acc1",
      location_id: "hloc1",
      catalog_id: "cat1",
      customer_list_id: "cl1",
    }),
    text: async () => "",
  }) as any;

describe("HubRiseOauthService.buildAuthorizeUrl — scope", () => {
  it("lists each resource type at most once (HubRise rejects duplicates)", () => {
    const config = {
      get: (k: string) =>
        ({
          "app.platforms.hubrise.appId": "client-abc",
          "app.platforms.hubrise.oauthAuthorizeUrl":
            "https://manager.hubrise.com/oauth2/v1/authorize",
          "app.platforms.hubrise.redirectUri":
            "https://api.example.com/api/v1/integrations/hubrise/callback",
        })[k],
    } as any;
    const jwt = { sign: () => "state.jwt" } as any;
    const svc = new HubRiseOauthService({} as any, jwt, config, {} as any);

    const url = new URL(
      svc.buildAuthorizeUrl({ tenantId: "T", userId: "U", locationId: "L" }),
    );
    const scope = url.searchParams.get("scope")!;
    // e.g. "location[orders.write,catalog.write,customer_list.read]"
    const inner = scope.replace(/^location\[/, "").replace(/\]$/, "");
    const resources = inner.split(",").map((p) => p.split(".")[0]);
    expect(new Set(resources).size).toBe(resources.length);
    expect(resources).toContain("orders");
    expect(resources).toContain("catalog");
  });
});

describe("HubRiseOauthService.handleCallback — callback registration", () => {
  it("registers via POST /callback with a nested event map, then saves the token", async () => {
    const calls: any[] = [];
    const fetchMock = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, opts });
      if (url.endsWith("/oauth2/v1/token")) return tokenOk();
      // callback registration
      return { ok: true, status: 201, text: async () => "" } as any;
    });
    const { svc, prisma } = makeService(fetchMock);

    const result = await svc.handleCallback({ code: "code1", state: "state1" });

    const cbCall = calls.find((c) => c.url === "https://api.hubrise.com/v1/callback");
    expect(cbCall).toBeTruthy();
    expect(cbCall.opts.method).toBe("POST");
    const sentBody = JSON.parse(cbCall.opts.body);
    // The registered URL is our per-location receiver.
    expect(sentBody.url).toBe(
      "https://api.example.com/api/v1/integrations/hubrise/L1".replace(
        "integrations/hubrise",
        "webhooks/hubrise",
      ),
    );
    // Nested map, NOT a dotted flat array.
    expect(Array.isArray(sentBody.events)).toBe(false);
    expect(sentBody.events.order).toEqual(["create", "update"]);
    expect(sentBody.events.catalog).toEqual(["update"]);
    // No legacy /webhooks endpoint is ever hit.
    expect(calls.some((c) => c.url.endsWith("/webhooks"))).toBe(false);

    expect(prisma.location.update).toHaveBeenCalledTimes(1);
    expect(result.webhookRegistered).toBe(true);
  });

  it("updates in place (PUT /callback) when the connection already has one", async () => {
    const methods: string[] = [];
    const fetchMock = jest.fn(async (url: string, opts: any) => {
      if (url.endsWith("/oauth2/v1/token")) return tokenOk();
      methods.push(opts.method);
      if (opts.method === "POST")
        return { ok: false, status: 409, text: async () => "exists" } as any;
      return { ok: true, status: 200, text: async () => "" } as any; // PUT
    });
    const { svc } = makeService(fetchMock);
    const result = await svc.handleCallback({ code: "c", state: "s" });
    expect(methods).toEqual(["POST", "PUT"]);
    expect(result.webhookRegistered).toBe(true);
  });

  it("still SAVES the token when callback registration fails (non-fatal)", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith("/oauth2/v1/token")) return tokenOk();
      return { ok: false, status: 500, text: async () => "boom" } as any;
    });
    const { svc, prisma } = makeService(fetchMock);

    const result = await svc.handleCallback({ code: "c", state: "s" });

    expect(prisma.location.update).toHaveBeenCalledTimes(1);
    expect(result.webhookRegistered).toBe(false);
    expect(result.locationId).toBe("L1");
  });
});
