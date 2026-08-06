// The shipped agreements have to survive the two things that silently mangle
// a contract: markup the PDF renderer drops, and placeholders nobody fills.
//
// Both fail quietly in production — the operator sends a contract with a
// clause missing from the PDF, or with "{{clientName}}" printed where a
// company name should be, and only finds out when a client asks. Cheap to
// pin here.

import { STARTER_TEMPLATES } from "../starter-templates";
import { ContractPdfService } from "../contract-pdf.service";

/** Exactly what ContractPdfService lays out — see its block regex. */
const RENDERABLE = new Set(["h1", "h2", "h3", "p", "li", "ul", "ol", "br", "strong", "em"]);

/** Keys contracts.service.fillPlaceholders actually substitutes. */
const KNOWN_PLACEHOLDERS = new Set([
  "recipientName",
  "recipientEmail",
  "recipientCompany",
  "location",
  "date",
  "amount",
]);

describe("starter templates", () => {
  it("ships the agreements the operator expects", () => {
    const keys = STARTER_TEMPLATES.map((t) => t.key);
    expect(keys).toContain("saas-agreement");
    expect(keys).toContain("free-trial");
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const t of STARTER_TEMPLATES) {
    describe(t.name, () => {
      it("uses only markup the PDF renderer keeps", () => {
        const tags = [...t.bodyHtml.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map(
          (m) => m[1].toLowerCase(),
        );
        const unsupported = [...new Set(tags)].filter(
          (tag) => !RENDERABLE.has(tag),
        );
        expect(unsupported).toEqual([]);
      });

      it("references only placeholders that get filled", () => {
        const used = [...t.bodyHtml.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
          (m) => m[1],
        );
        const unknown = [...new Set(used)].filter(
          (k) => !KNOWN_PLACEHOLDERS.has(k),
        );
        expect(unknown).toEqual([]);
      });

      it("names Order Hub Solutions and its company number", () => {
        expect(t.bodyHtml).toContain("Order Hub Solutions Ltd");
        expect(t.bodyHtml).toContain("16608545");
        expect(t.bodyHtml).toContain("NE37 2LL");
      });

      it("renders to a real PDF", async () => {
        const svc = Object.create(ContractPdfService.prototype) as any;
        svc.logger = { log() {}, warn() {}, error() {} };
        const bytes = await svc.build({
          title: t.name,
          bodyHtml: t.bodyHtml,
          recipientName: "Sam Patel",
          recipientEmail: "sam@example.com",
          recipientCompany: "Patel Foods Ltd",
          status: "SIGNED",
          signerName: "Sam Patel",
          signedAt: new Date("2026-01-02T10:00:00Z"),
          signerIp: "1.2.3.4",
          signerUserAgent: "Safari",
          token: "tok",
          id: "c1",
          events: [],
        });
        expect(Buffer.isBuffer(bytes)).toBe(true);
        // %PDF- magic, and long enough to be more than an empty shell.
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(3000);
      }, 30_000);
    });
  }
});

describe("issuer on the certificate", () => {
  const { defaultIssuer, resolveIssuer } = require("../issuer");

  it("defaults to Order Hub Solutions with its company number", () => {
    const d = defaultIssuer(() => undefined);
    expect(d.name).toBe("Order Hub Solutions Ltd");
    expect(d.companyNumber).toBe("16608545");
    expect(d.address).toContain("NE37 2LL");
  });

  it("lets a deployment override the entity entirely", () => {
    const d = defaultIssuer((k: string) =>
      k === "CONTRACT_ISSUER_NAME" ? "Other Co Ltd" : undefined,
    );
    expect(d.name).toBe("Other Co Ltd");
  });

  it("overrides field by field, keeping the rest", () => {
    const base = defaultIssuer(() => undefined);
    const r = resolveIssuer(base, { name: "Trading Name Ltd" });
    expect(r.name).toBe("Trading Name Ltd");
    // Not blanked just because the override omitted it.
    expect(r.companyNumber).toBe("16608545");
  });

  it("ignores blank overrides rather than emptying the field", () => {
    const base = defaultIssuer(() => undefined);
    const r = resolveIssuer(base, { name: "   ", address: "" });
    expect(r.name).toBe("Order Hub Solutions Ltd");
    expect(r.address).toContain("Sunningdale");
  });

  it("prints Issued by on the certificate", async () => {
    const { ContractPdfService } = require("../contract-pdf.service");
    const svc = Object.create(ContractPdfService.prototype) as any;
    svc.logger = { log() {}, warn() {}, error() {} };
    const bytes = await svc.build({
      title: "Agreement",
      bodyHtml: "<p>Terms</p>",
      recipientName: "Sam",
      status: "SIGNED",
      signerName: "Sam",
      signedAt: new Date("2026-01-01T00:00:00Z"),
      id: "c1",
      issuer: defaultIssuer(() => undefined),
      events: [],
    });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);
});
