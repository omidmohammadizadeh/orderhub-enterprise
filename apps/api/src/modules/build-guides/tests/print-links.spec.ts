import { makePrintToken, PRINT_LINK_TTL_SECONDS, readPrintToken } from "../print-links";

const SECRET = "x".repeat(40);
const claims = { kind: "charts-menu" as const, id: "menu_1", tenantId: "tenant_1" };

describe("print links", () => {
  it("round-trips kind, id and tenant", () => {
    const t = makePrintToken(SECRET, claims, 1000);
    expect(readPrintToken(SECRET, t, 1001)).toEqual({ ...claims, exp: 1000 + PRINT_LINK_TTL_SECONDS });
  });

  it("rejects an expired link", () => {
    const t = makePrintToken(SECRET, claims, 1000);
    expect(readPrintToken(SECRET, t, 1001 + PRINT_LINK_TTL_SECONDS)).toBeNull();
  });

  it("rejects another secret and a tampered payload", () => {
    const t = makePrintToken(SECRET, claims, 1000);
    expect(readPrintToken("y".repeat(40), t, 1001)).toBeNull();
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, tenantId: "other", exp: 9e9 })).toString("base64url");
    expect(readPrintToken(SECRET, `${forged}.${sig}`, 1001)).toBeNull();
  });

  it("rejects junk", () => {
    expect(readPrintToken(SECRET, "nope", 1)).toBeNull();
    expect(readPrintToken(SECRET, undefined, 1)).toBeNull();
  });
});
