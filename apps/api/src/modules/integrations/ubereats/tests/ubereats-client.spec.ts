import * as crypto from "crypto";
import { UberEatsClientService } from "../ubereats-client.service";

// Uber signs webhooks with X-Uber-Signature = lowercase hex
// HMAC-SHA256(rawBody) keyed with the CLIENT SECRET (webhooks guide). Some
// apps also issue a dedicated signing key — the verifier accepts a match on
// either UBER_EATS_CLIENT_SECRET or UBER_EATS_WEBHOOK_SECRET.

const CLIENT_SECRET = "uber_client_secret_test_123";
const WEBHOOK_SECRET = "uber_webhook_key_test_456";

function makeService(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "app.platforms.uberEats.clientId": "client-id-1",
    "app.platforms.uberEats.clientSecret": CLIENT_SECRET,
    "app.platforms.uberEats.webhookSecret": WEBHOOK_SECRET,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] ?? "" } as any;
  return new UberEatsClientService(config);
}

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("UberEatsClientService.verifyWebhookSignature", () => {
  const body =
    '{"event_type":"orders.notification","event_id":"evt-1","resource_id":"order-1"}';

  it("accepts a signature keyed with the client secret", () => {
    const svc = makeService();
    expect(svc.verifyWebhookSignature(body, sign(body, CLIENT_SECRET))).toBe(
      true,
    );
  });

  it("accepts a signature keyed with the dedicated webhook secret", () => {
    const svc = makeService();
    expect(svc.verifyWebhookSignature(body, sign(body, WEBHOOK_SECRET))).toBe(
      true,
    );
  });

  it("accepts uppercase hex from the sender (compared lowercased)", () => {
    const svc = makeService();
    const sig = sign(body, CLIENT_SECRET).toUpperCase();
    expect(svc.verifyWebhookSignature(body, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const svc = makeService();
    expect(
      svc.verifyWebhookSignature(body + " ", sign(body, CLIENT_SECRET)),
    ).toBe(false);
  });

  it("rejects wrong/missing signatures", () => {
    const svc = makeService();
    expect(svc.verifyWebhookSignature(body, "deadbeef")).toBe(false);
    expect(svc.verifyWebhookSignature(body, undefined)).toBe(false);
    expect(svc.verifyWebhookSignature(body, "")).toBe(false);
  });

  it("rejects everything when no secrets are configured", () => {
    const svc = makeService({
      "app.platforms.uberEats.clientSecret": "",
      "app.platforms.uberEats.webhookSecret": "",
    });
    expect(svc.verifyWebhookSignature(body, sign(body, CLIENT_SECRET))).toBe(
      false,
    );
  });

  it("verifies identical raw bytes whether passed as string or Buffer", () => {
    const svc = makeService();
    const sig = sign(body, CLIENT_SECRET);
    expect(svc.verifyWebhookSignature(Buffer.from(body), sig)).toBe(true);
  });
});

describe("UberEatsClientService.getToken", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("caches tokens per scope-set and re-fetches only near expiry", async () => {
    const svc = makeService();
    const calls: string[] = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      const params = new URLSearchParams(init.body);
      calls.push(params.get("scope") ?? "");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 2_592_000 }),
      } as any;
    }) as any;

    const t1 = await svc.getToken(["eats.order"]);
    const t2 = await svc.getToken(["eats.order"]); // cached
    const t3 = await svc.getToken(["eats.store"]); // different scope → new token
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(t3).toBe("tok-2");
    expect(calls).toEqual(["eats.order", "eats.store"]);
  });

  it("sends client_credentials with the scope string", async () => {
    const svc = makeService();
    let sent: URLSearchParams | null = null;
    global.fetch = jest.fn(async (_url: any, init: any) => {
      sent = new URLSearchParams(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: "tok", expires_in: 100_000 }),
      } as any;
    }) as any;
    await svc.getToken(["eats.store", "eats.order"]);
    expect(sent!.get("grant_type")).toBe("client_credentials");
    expect(sent!.get("client_id")).toBe("client-id-1");
    expect(sent!.get("client_secret")).toBe(CLIENT_SECRET);
    // scopes are sorted so the cache key is stable
    expect(sent!.get("scope")).toBe("eats.order eats.store");
  });
});
