import { buildAudienceQuery, emailCostMinor, normaliseEmail } from "../email-audience";
import { makeEmailToken, readEmailToken, verifySvixSignature } from "../email-tokens";
import { createHmac } from "crypto";

const NOW = new Date("2026-10-04T12:00:00Z");

describe("buildAudienceQuery", () => {
  it("only ever selects SUBSCRIBED contacts of the tenant", () => {
    const q = buildAudienceQuery("t1", { segment: "ALL" }, null, "rows", NOW);
    expect(q.sql).toContain(`ec.status = 'SUBSCRIBED'`);
    expect(q.sql).toContain(`ec."tenantId" = $1`);
    expect(q.params).toEqual(["t1"]);
  });

  it("never counts unpaid, cancelled or sandbox orders towards a segment", () => {
    const q = buildAudienceQuery("t1", { segment: "LOYAL" }, null, "count", NOW);
    expect(q.sql).toContain(`'PENDING','CANCELLED','REJECTED','FAILED'`);
    expect(q.sql).toContain(`o."isSandbox" = false`);
  });

  it("LAPSED = ordered before, not within the window", () => {
    const q = buildAudienceQuery("t1", { segment: "LAPSED", days: 45 }, null, "rows", NOW);
    expect(q.sql).toContain("s.last_at < $2");
    expect(q.params[1]).toEqual(new Date("2026-08-20T12:00:00Z"));
  });

  it("NEVER_ORDERED has no order stats at all", () => {
    const q = buildAudienceQuery("t1", { segment: "NEVER_ORDERED" }, null, "rows", NOW);
    expect(q.sql).toContain("s.email IS NULL");
  });

  it("scopes a franchisee to contacts homed at, or who ordered from, their shops", () => {
    const q = buildAudienceQuery("t1", { segment: "LOYAL", minOrders: 3 }, ["L1", "L2"], "rows", NOW);
    expect(q.params).toEqual(["t1", ["L1", "L2"], 3]);
    expect(q.sql).toContain(`o."locationId" = ANY($2::text[])`);
    expect(q.sql).toContain(`ec."locationId" = ANY($2::text[]) OR s.email IS NOT NULL`);
    expect(q.sql).toContain("s.n >= $3");
  });

  it("clamps silly numbers instead of passing them to SQL", () => {
    const q = buildAudienceQuery("t1", { segment: "RECENT", days: -5 }, null, "rows", NOW);
    expect(q.params[1]).toEqual(new Date("2026-10-03T12:00:00Z"));
  });

  it("filters by brand and tags as parameters, never interpolated", () => {
    const q = buildAudienceQuery("t1", { segment: "ALL", brandId: "b'1", tags: ["vip"] }, null, "rows", NOW);
    expect(q.sql).not.toContain("b'1");
    expect(q.params).toEqual(["t1", "b'1", ["vip"]]);
  });
});

describe("normaliseEmail / emailCostMinor", () => {
  it("lower-cases and rejects junk", () => {
    expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it("rounds a part-thousand UP, so a single email is never free", () => {
    expect(emailCostMinor(0, 300)).toBe(0);
    expect(emailCostMinor(1, 300)).toBe(1);
    expect(emailCostMinor(1000, 300)).toBe(300);
    expect(emailCostMinor(1001, 300)).toBe(301);
    expect(emailCostMinor(500, 0)).toBe(0);
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips and refuses a tampered or foreign token", () => {
    const t = makeEmailToken("secret", "r", "rec_123");
    expect(readEmailToken("secret", t)).toEqual({ kind: "r", id: "rec_123" });
    expect(readEmailToken("other", t)).toBeNull();
    const forged = makeEmailToken("secret", "r", "rec_999").split(".")[0] + "." + t.split(".")[1];
    expect(readEmailToken("secret", forged)).toBeNull();
    expect(readEmailToken("secret", "garbage")).toBeNull();
    expect(readEmailToken("", t)).toBeNull();
  });
});

describe("verifySvixSignature", () => {
  const key = Buffer.from("resend-test-key").toString("base64");
  const secret = `whsec_${key}`;
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
  const sign = (id: string, ts: string) =>
    "v1," + createHmac("sha256", Buffer.from(key, "base64")).update(`${id}.${ts}.${body}`).digest("base64");

  it("accepts Resend's signature", () => {
    expect(
      verifySvixSignature({ secret, id: "msg_1", timestamp: "1000", signature: `v1,bogus ${sign("msg_1", "1000")}`, body, nowSeconds: 1010 }),
    ).toBe(true);
  });

  it("rejects a changed body, a wrong secret and a replay", () => {
    const sig = sign("msg_1", "1000");
    expect(verifySvixSignature({ secret, id: "msg_1", timestamp: "1000", signature: sig, body: body + " ", nowSeconds: 1000 })).toBe(false);
    expect(verifySvixSignature({ secret: "whsec_eA==", id: "msg_1", timestamp: "1000", signature: sig, body, nowSeconds: 1000 })).toBe(false);
    expect(verifySvixSignature({ secret, id: "msg_1", timestamp: "1000", signature: sig, body, nowSeconds: 2000 })).toBe(false);
    expect(verifySvixSignature({ secret: "", id: "msg_1", timestamp: "1000", signature: sig, body, nowSeconds: 1000 })).toBe(false);
  });
});
