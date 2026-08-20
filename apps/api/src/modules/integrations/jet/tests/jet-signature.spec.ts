import * as crypto from "crypto";
import {
  JetClientService,
  parseJetSignatureHeader,
} from "../jet-client.service";

// The webhook verifier is security-critical: get the signing input wrong and
// we either reject every real order or accept spoofed ones.
//
// JET's spec documents the scheme AND gives a worked example, which is the
// only reason this can be asserted rather than assumed:
//   secret "key" + body "example" → "FGwot7AqiDIthEv6TippJm35DaRpRac5NSLd/wSp9go="
// That vector is the first test below and pins the signed input to the RAW
// BODY ALONE — the `t` timestamp in the header is not part of it, which is the
// opposite of Stripe/Deliveroo and the easiest thing here to get wrong.

const SECRET = "whsec_jet_test_123";
const INBOUND_KEY = "inbound-key-abc";

function makeService(
  overrides: Record<string, string> = {},
): JetClientService {
  const values: Record<string, string> = {
    "app.platforms.jet.webhookSecret": SECRET,
    "app.platforms.jet.inboundApiKey": INBOUND_KEY,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] ?? "" } as any;
  const credentials = { configured: () => true, resolve: async () => ({}) } as any;
  return new JetClientService(config, credentials);
}

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function header(body: string, t = 1673428038618): string {
  return `HMAC-SHA256 t=${t},signature=${sign(body)}`;
}

describe("JET signature — the spec's own vector", () => {
  it("reproduces the documented example exactly", () => {
    const svc = makeService({ "app.platforms.jet.webhookSecret": "key" });
    const documented = "FGwot7AqiDIthEv6TippJm35DaRpRac5NSLd/wSp9go=";
    expect(
      svc.verifyWebhookSignature(
        "example",
        `HMAC-SHA256 t=1673428038618,signature=${documented}`,
      ),
    ).toBe(true);
  });

  it("ignores the timestamp — it is not part of the signed input", () => {
    const svc = makeService();
    const body = '{"id":"abc","type":"collection-by-customer"}';
    // Same body, wildly different timestamps, both verify.
    expect(svc.verifyWebhookSignature(body, header(body, 1))).toBe(true);
    expect(svc.verifyWebhookSignature(body, header(body, 9_999_999_999_999))).toBe(
      true,
    );
  });
});

describe("parseJetSignatureHeader", () => {
  it("splits the documented header format", () => {
    const parsed = parseJetSignatureHeader(
      "HMAC-SHA256 t=1673428038618,signature=gy7evLHPTUadsmEVw7h6HmOHafCLq4gLKlss1VCV8lI=",
    );
    expect(parsed.timestampMs).toBe(1673428038618);
    expect(parsed.signature).toBe(
      "gy7evLHPTUadsmEVw7h6HmOHafCLq4gLKlss1VCV8lI=",
    );
  });

  it("keeps base64 padding intact (the value contains '=')", () => {
    const parsed = parseJetSignatureHeader("t=1,signature=YWJjZA==");
    expect(parsed.signature).toBe("YWJjZA==");
  });

  it("tolerates reordered pairs and missing algorithm prefix", () => {
    const parsed = parseJetSignatureHeader("signature=abc123,t=42");
    expect(parsed.signature).toBe("abc123");
    expect(parsed.timestampMs).toBe(42);
  });

  it("returns nulls for a missing or malformed header", () => {
    expect(parseJetSignatureHeader(undefined).signature).toBeNull();
    expect(parseJetSignatureHeader("").signature).toBeNull();
    expect(parseJetSignatureHeader("t=1").signature).toBeNull();
  });
});

describe("JetClientService.verifyWebhookSignature", () => {
  const svc = makeService();
  const body = '{"id":"38bbeb45","third_party_order_reference":"22721763"}';

  it("accepts a correctly signed body", () => {
    expect(svc.verifyWebhookSignature(body, header(body))).toBe(true);
  });

  it("accepts the raw bytes as a Buffer", () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), header(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = header(body);
    expect(svc.verifyWebhookSignature(body + " ", sig)).toBe(false);
    expect(
      svc.verifyWebhookSignature(body.replace("22721763", "99999999"), sig),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const foreign = `HMAC-SHA256 t=1,signature=${sign(body, "not-our-secret")}`;
    expect(svc.verifyWebhookSignature(body, foreign)).toBe(false);
  });

  it("rejects a missing or empty signature", () => {
    expect(svc.verifyWebhookSignature(body, undefined)).toBe(false);
    expect(svc.verifyWebhookSignature(body, "")).toBe(false);
    expect(svc.verifyWebhookSignature(body, "HMAC-SHA256 t=1,signature=")).toBe(
      false,
    );
  });

  it("rejects everything when no secret is configured", () => {
    const unconfigured = makeService({ "app.platforms.jet.webhookSecret": "" });
    expect(unconfigured.verifyWebhookSignature(body, header(body))).toBe(false);
    expect(unconfigured.webhookSecretConfigured).toBe(false);
  });

  it("rejects a hex-encoded signature (JET uses base64)", () => {
    const hex = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(
      svc.verifyWebhookSignature(body, `HMAC-SHA256 t=1,signature=${hex}`),
    ).toBe(false);
  });
});

describe("JetClientService.diagnoseSignatureVariant", () => {
  const svc = makeService();
  const body = '{"id":"abc"}';

  it("names the scheme when the secret is right but the format differs", () => {
    // A sender folding the timestamp in the way Stripe does. The secret is
    // ours, so the diagnostic must say so — that is an code fix, not an env one.
    const t = "1673428038618";
    const sig = crypto
      .createHmac("sha256", SECRET)
      .update(`${t}.${body}`)
      .digest("base64");
    expect(
      svc.diagnoseSignatureVariant(body, `HMAC-SHA256 t=${t},signature=${sig}`),
    ).toBe("t.body");
  });

  it("detects a hex-encoded variant of the correct scheme", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(
      svc.diagnoseSignatureVariant(body, `t=1,signature=${sig}`),
    ).toBe("body_only(hex)");
  });

  it("reports no_match when the secret VALUE is wrong", () => {
    const sig = crypto.createHmac("sha256", "wrong").update(body).digest("base64");
    expect(svc.diagnoseSignatureVariant(body, `t=1,signature=${sig}`)).toBe(
      "no_match",
    );
  });

  it("distinguishes an unset secret from a wrong one", () => {
    const unconfigured = makeService({ "app.platforms.jet.webhookSecret": "" });
    expect(unconfigured.diagnoseSignatureVariant(body, "t=1,signature=x")).toBe(
      "no_secret",
    );
    expect(svc.diagnoseSignatureVariant(body, undefined)).toBe("no_signature");
  });
});

describe("JetClientService.verifyInboundApiKey", () => {
  const svc = makeService();

  it("accepts the configured key, bare or Bearer-prefixed", () => {
    expect(svc.verifyInboundApiKey(INBOUND_KEY)).toBe(true);
    expect(svc.verifyInboundApiKey(`Bearer ${INBOUND_KEY}`)).toBe(true);
  });

  it("rejects a wrong or missing key", () => {
    expect(svc.verifyInboundApiKey("nope")).toBe(false);
    expect(svc.verifyInboundApiKey(undefined)).toBe(false);
    expect(svc.verifyInboundApiKey("")).toBe(false);
  });

  it("accepts anything when no inbound key is configured, and says so", () => {
    // Deliberate: rejecting every webhook on a fresh deploy would silently
    // drop live orders. The receiver logs the unauthenticated state instead.
    const open = makeService({ "app.platforms.jet.inboundApiKey": "" });
    expect(open.verifyInboundApiKey(undefined)).toBe(true);
    expect(open.inboundApiKeyConfigured).toBe(false);
  });
});
