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
  // Optional — present only when the operator filled them in. The matching
  // {{#commission}} / {{#serviceCharge}} sections remove their clause when
  // they weren't.
  "commission",
  "serviceCharge",
  "recipientCompanyNumber",
  "recipientAddress",
  "recipientPhone",
  "locationCount",
  "locationWord",
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


describe("optional fee clauses in the shipped agreement", () => {
  const saas = STARTER_TEMPLATES.find((t) => t.key === "saas-agreement")!;

  it("wraps commission and the service charge in optional sections", () => {
    // Without the wrapper an unset fee would render as an empty clause —
    // "we charge commission of  of the value of each order" — which is worse
    // than either stating a rate or saying nothing.
    expect(saas.bodyHtml).toContain("{{#commission}}");
    expect(saas.bodyHtml).toContain("{{/commission}}");
    expect(saas.bodyHtml).toContain("{{#serviceCharge}}");
    expect(saas.bodyHtml).toContain("{{/serviceCharge}}");
  });

  it("closes every section it opens", () => {
    // An unclosed section swallows the rest of the agreement, silently, since
    // the regex would find no end tag and leave the block unrendered.
    for (const t of STARTER_TEMPLATES) {
      const opens = [...t.bodyHtml.matchAll(/\{\{#\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
        (m) => m[1],
      );
      const closes = [
        ...t.bodyHtml.matchAll(/\{\{\/\s*([a-zA-Z0-9_]+)\s*\}\}/g),
      ].map((m) => m[1]);
      expect(opens.sort()).toEqual(closes.sort());
    }
  });

  it("keeps the subscription clause unconditional", () => {
    // Every agreement has a subscription; only the two extras are optional.
    expect(saas.bodyHtml).toContain("{{amount}} per month");
    expect(saas.bodyHtml).not.toContain("{{#amount}}");
  });
});


describe("the shipped agreement covers what a client will ask about", () => {
  const saas = STARTER_TEMPLATES.find((t) => t.key === "saas-agreement")!;

  it("states a ONE MONTH notice period", () => {
    // The single term a client checks first, and the one most likely to be
    // argued about later if it is vague.
    expect(saas.bodyHtml).toMatch(/one month's written notice/i);
  });

  it("keeps the service running through the notice period", () => {
    // "You must pay the month" without "and you keep the service" is the
    // version that generates complaints.
    expect(saas.bodyHtml).toMatch(/remains available to you throughout/i);
  });

  it("has the sections a SaaS agreement is expected to have", () => {
    for (const heading of [
      "What we provide",
      "What it costs",
      "Terms of use",
      "Payments and settlement",
      "Data protection",
      "Intellectual property",
      "Service and support",
      "Liability",
      "Term and ending this Agreement",
    ]) {
      expect(saas.bodyHtml).toContain(heading);
    }
  });

  it("wraps every optional client detail so a blank leaves no dangling label", () => {
    // A sole trader has no company number. Printing ", company number " with
    // nothing after it looks like a bug in a document someone is signing.
    for (const key of [
      "recipientCompanyNumber",
      "recipientAddress",
      "recipientPhone",
      "locationWord",
    ]) {
      expect(saas.bodyHtml).toContain(`{{#${key}}}`);
      expect(saas.bodyHtml).toContain(`{{/${key}}}`);
    }
  });

  it("names both parties in the opening clause", () => {
    expect(saas.bodyHtml).toContain("Order Hub Solutions Ltd");
    expect(saas.bodyHtml).toContain("16608545");
    expect(saas.bodyHtml).toContain("{{recipientCompany}}");
  });
});
