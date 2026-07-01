import * as crypto from "crypto";
import { DeliverooClientService } from "../deliveroo-client.service";

// The webhook verifier is security-critical: a wrong signing string would
// either reject real orders or accept spoofed ones. Deliveroo signs
// `${sequenceGuid} ${rawBody}` (legacy new_order/cancel_order use
// `${sequenceGuid} \n ${rawBody}`) with HMAC-SHA256 hex over the RAW bytes.

const SECRET = "whsec_test_deliveroo_123";

function makeService(): DeliverooClientService {
  const config = {
    get: (key: string) =>
      key === "app.platforms.deliveroo.webhookSecret" ? SECRET : "",
  } as any;
  return new DeliverooClientService(config);
}

function sign(sequence: string, body: string, legacy = false): string {
  const h = crypto.createHmac("sha256", SECRET);
  h.update(sequence);
  h.update(legacy ? " \n " : " ");
  h.update(Buffer.from(body));
  return h.digest("hex");
}

describe("DeliverooClientService.verifyWebhookSignature", () => {
  const svc = makeService();
  const seq = "8f3c2b1a-0000-4444-8888-abcdef012345";
  const body = '{"event":"order.new","order":{"id":"gb:abc123"}}';

  it("accepts a correctly-signed (standard) webhook", () => {
    expect(svc.verifyWebhookSignature(seq, body, sign(seq, body))).toBe(true);
  });

  it("accepts a correctly-signed legacy (new_order) webhook", () => {
    const legacyBody = '{"event":"new_order"}';
    const sig = sign(seq, legacyBody, true);
    expect(svc.verifyWebhookSignature(seq, legacyBody, sig, true)).toBe(true);
  });

  it("rejects a standard signature checked as legacy (separator matters)", () => {
    expect(svc.verifyWebhookSignature(seq, body, sign(seq, body), true)).toBe(
      false,
    );
  });

  it("rejects a tampered body", () => {
    const sig = sign(seq, body);
    expect(
      svc.verifyWebhookSignature(seq, body + " ", sig),
    ).toBe(false);
  });

  it("rejects a wrong/missing signature", () => {
    expect(svc.verifyWebhookSignature(seq, body, "deadbeef")).toBe(false);
    expect(svc.verifyWebhookSignature(seq, body, undefined)).toBe(false);
    expect(svc.verifyWebhookSignature(seq, body, "")).toBe(false);
  });

  it("rejects when the sequence guid doesn't match", () => {
    const sig = sign(seq, body);
    expect(svc.verifyWebhookSignature("different-guid", body, sig)).toBe(false);
  });

  it("verifies identical raw bytes whether passed as string or Buffer", () => {
    const sig = sign(seq, body);
    expect(svc.verifyWebhookSignature(seq, Buffer.from(body), sig)).toBe(true);
  });
});
