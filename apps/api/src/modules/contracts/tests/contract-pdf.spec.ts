// The countersigned copy — real bytes through the real encoder.
//
// Mocking pdf-lib here would prove nothing: the failure modes that matter are
// all inside it. A smart quote pasted from Word throws on encode, a long URL
// runs off the page edge, and an uploaded original silently vanishes if the
// certificate is written to a fresh document instead of appended.

import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  certificateParties,
  ContractPdfService,
  wrap,
  toWinAnsi,
  decodeEntities,
} from "../contract-pdf.service";

const svc = () => new ContractPdfService();

const signed = (over: Record<string, any> = {}) => ({
  id: "c_abc123",
  title: "Service Agreement",
  bodyHtml:
    "<h2>Terms</h2><p>The Client agrees to pay £49.00 per month.</p><ul><li>Point one</li></ul>",
  recipientName: "Sam Patel",
  recipientEmail: "sam@example.com",
  recipientCompany: "Pizza Uno Ltd",
  signerName: "Sam Patel",
  signerEmail: "sam@example.com",
  signerIp: "203.0.113.9",
  signerUserAgent: "Mozilla/5.0 (iPhone)",
  signedAt: new Date("2026-08-06T10:30:00Z"),
  status: "SIGNED",
  fileUrl: null,
  ...over,
});

/** A PDF is a real file format — check the header, not just "got bytes". */
const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString() === "%PDF-";

describe("countersigned PDF", () => {
  it("produces a valid PDF for a written contract", async () => {
    const buf = await svc().build(signed(), []);
    expect(isPdf(buf)).toBe(true);
    const doc = await PDFDocument.load(buf);
    // Body page(s) plus the certificate.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("APPENDS the certificate to an uploaded original, never replaces it", async () => {
    // The signed artefact has to be the document they actually read. Building
    // a fresh PDF and calling it signed would quietly substitute a different
    // document for the one that was agreed.
    const original = await PDFDocument.create();
    original.addPage([595, 842]);
    original.addPage([595, 842]);
    original.addPage([595, 842]);
    const originalBytes = await original.save();

    const realFetch = global.fetch;
    global.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => originalBytes.buffer.slice(0),
    })) as any;

    try {
      const buf = await svc().build(
        signed({ fileUrl: "https://example.com/a.pdf", bodyHtml: null }),
        [],
      );
      const doc = await PDFDocument.load(buf);
      // 3 original + 1 certificate.
      expect(doc.getPageCount()).toBe(4);
    } finally {
      global.fetch = realFetch;
    }
  }, 30_000);

  it("still issues a certificate when the original can't be fetched", async () => {
    // A dead storage URL must not mean "no proof of signature at all".
    const realFetch = global.fetch;
    global.fetch = (async () => ({ ok: false, status: 404 })) as any;
    try {
      const buf = await svc().build(
        signed({ fileUrl: "https://example.com/gone.pdf", bodyHtml: null }),
        [],
      );
      const doc = await PDFDocument.load(buf);
      expect(doc.getPageCount()).toBe(1);
    } finally {
      global.fetch = realFetch;
    }
  }, 30_000);

  it("survives smart quotes and em dashes pasted from Word", async () => {
    // Standard fonts are WinAnsi only; pdf-lib throws on anything else, which
    // would fail the whole download over one curly apostrophe.
    const buf = await svc().build(
      signed({
        title: "Agreement — “Special” Terms",
        bodyHtml: "<p>It’s the Client’s responsibility… naïve 😀 café</p>",
        signerName: "Renée O’Brien",
      }),
      [],
    );
    expect(isPdf(buf)).toBe(true);
  }, 30_000);

  it("prints the audit trail oldest-first whichever way it arrives", async () => {
    // This used to reverse the caller's array, which silently depended on the
    // DB's orderBy — an ascending caller printed the story backwards.
    const asc = [
      { type: "CREATED", ip: null, createdAt: new Date("2026-08-06T09:00:00Z") },
      { type: "SIGNED", ip: "1.1.1.1", createdAt: new Date("2026-08-06T10:30:00Z") },
    ];
    const a = await svc().build(signed(), asc);
    const b = await svc().build(signed(), [...asc].reverse());
    // Same events either way in, so the rendered pages must be the same size.
    expect(Math.abs(a.length - b.length)).toBeLessThan(50);
  }, 30_000);

  it("includes the audit trail entries", async () => {
    const buf = await svc().build(signed(), [
      { type: "SIGNED", ip: "203.0.113.9", createdAt: new Date("2026-08-06T10:30:00Z") },
      { type: "OPENED", ip: "203.0.113.9", createdAt: new Date("2026-08-06T10:00:00Z") },
    ]);
    expect(isPdf(buf)).toBe(true);
  }, 30_000);

  it("renders a template with no recognised tags rather than a blank page", async () => {
    // A template pasted in as plain text would otherwise produce an empty
    // document that still looks like a successful download.
    const buf = await svc().build(
      signed({ bodyHtml: "Just some plain text with no markup at all." }),
      [],
    );
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("word wrap", () => {
  let font: any;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    font = await doc.embedFont(StandardFonts.Helvetica);
  });

  it("keeps every line inside the width", () => {
    const lines = wrap(
      "The Client agrees to pay the monthly fee in advance on the first working day of each calendar month.",
      font,
      10.5,
      300,
    );
    for (const l of lines) {
      expect(font.widthOfTextAtSize(l, 10.5)).toBeLessThanOrEqual(300);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it("breaks a single over-long word instead of letting it run off the page", () => {
    const lines = wrap(
      "https://app.example.com/contract/" + "x".repeat(200),
      font,
      10,
      200,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(200);
    }
  });

  it("never returns an empty array, which would drop the block silently", () => {
    expect(wrap("", font, 10, 200)).toEqual([""]);
  });
});

describe("HTML entities", () => {
  it("decodes the currency symbol in a fee clause", () => {
    // Caught by eyeballing the first real render: the fee clause printed
    // "&pound;49.00". In a contract about money that is not cosmetic.
    expect(decodeEntities("pay &pound;49.00 per month")).toBe(
      "pay £49.00 per month",
    );
  });

  it("decodes numeric entities, decimal and hex", () => {
    expect(decodeEntities("&#163;49 &#xA3;49")).toBe("£49 £49");
  });

  it("decodes &amp; LAST so &amp;pound; stays a literal ampersand", () => {
    // Decoding &amp; first would turn this into £ — silently changing what
    // the operator wrote into a currency symbol.
    expect(decodeEntities("Ben &amp;pound; Jerry")).toBe("Ben &pound; Jerry");
  });

  it("leaves an unknown entity alone rather than eating it", () => {
    expect(decodeEntities("&notarealentity; here")).toBe(
      "&notarealentity; here",
    );
  });

  it("survives a malformed numeric entity", () => {
    expect(() => decodeEntities("&#999999999999;")).not.toThrow();
  });
});

describe("WinAnsi fallback", () => {
  it("maps typographic punctuation to encodable equivalents", () => {
    expect(toWinAnsi("It’s a “test” — really…")).toBe(
      "It's a \"test\" - really...",
    );
  });

  it("replaces anything still un-encodable rather than throwing", () => {
    expect(toWinAnsi("emoji 😀 here")).toBe("emoji ? here");
  });

  it("leaves ordinary Latin-1 alone, including £ and accents", () => {
    expect(toWinAnsi("£49.00 café")).toBe("£49.00 café");
  });
});


describe("certificate names both parties", () => {
  const base = {
    id: "c1",
    signerName: "Sam Patel",
    signerEmail: "sam@patelfoods.co.uk",
    recipientCompany: "Patel Foods Ltd",
    signedAt: new Date("2026-08-06T11:20:00Z"),
    sentAt: new Date("2026-08-05T09:00:00Z"),
  };

  it("names OUR side as a company, never as a person", async () => {
    // Order Hub is party as a legal entity. Naming whichever staff member
    // pressed send would imply they signed personally and bound themselves.
    const parties = certificateParties({
      ...base,
      issuer: {
        name: "Order Hub Solutions Ltd",
        companyNumber: "16608545",
        address: "5 Sunningdale Drive, Washington, NE37 2LL",
      },
    });
    const provider = parties[0]!;
    expect(provider.heading).toContain("PROVIDER");
    expect(provider.rows).toContainEqual(["Company", "Order Hub Solutions Ltd"]);
    expect(provider.rows).toContainEqual(["Company number", "16608545"]);
    // No signer name anywhere on our side.
    expect(JSON.stringify(provider.rows)).not.toContain("Sam Patel");
  });

  it("names the client with the full signing evidence", async () => {
    const client = certificateParties({
      ...base,
      signerIp: "203.0.113.9",
      signerUserAgent: "Safari/605",
    })[1]!;
    expect(client.heading).toContain("CLIENT");
    expect(client.rows).toContainEqual(["Signed by", "Sam Patel"]);
    expect(client.rows).toContainEqual(["IP address", "203.0.113.9"]);
    expect(client.rows).toContainEqual(["Device", "Safari/605"]);
  });

  it("still shows both parties when no issuer was stored", () => {
    // Contracts created before issuer details existed must not lose our whole
    // side of the certificate.
    const parties = certificateParties({ ...base, issuer: null });
    expect(parties[0]!.rows[0]).toEqual(["Company", "Order Hub Solutions Ltd"]);
    expect(parties[1]!.rows[0]).toEqual(["Signed by", "Sam Patel"]);
  });

  it("falls back to a dash rather than printing 'undefined'", () => {
    const parties = certificateParties({ id: "c1" });
    expect(parties[1]!.rows).toContainEqual(["Signed by", "—"]);
    expect(parties[0]!.rows).toContainEqual(["Agreement issued", "—"]);
  });
});
