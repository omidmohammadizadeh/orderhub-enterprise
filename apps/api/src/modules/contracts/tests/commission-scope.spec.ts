import { STARTER_TEMPLATES } from "../starter-templates";

// What the commission clause covers, in words a restaurant owner reads once.
//
// Clients asked whether we take a cut of their Just Eat and Uber Eats money.
// We do not, and never could — commission leaves the merchant's Stripe account
// as an application fee on payments WE process, and a marketplace order is
// paid by the marketplace direct to the shop. But the clause said "each order
// processed through the Platform", and a shop whose marketplace orders flow
// through our dashboard reads itself into that sentence.
//
// It must also not swing too far the other way: card payments taken at the
// till carry the same application fee (terminal.service.ts), so a clause
// promising commission only on website orders would understate what we charge.

const saas = STARTER_TEMPLATES.find((t) => t.key === "saas-agreement")!;

describe("SaaS agreement — the scope of order commission", () => {
  it("names the marketplaces it does NOT apply to", () => {
    for (const name of ["Just Eat", "Uber Eats", "Deliveroo"]) {
      expect(saas.bodyHtml).toContain(name);
    }
  });

  it("says plainly that marketplace orders carry no commission", () => {
    expect(saas.bodyHtml).toMatch(
      /no commission on orders placed through a third-party marketplace/i,
    );
  });

  it("still covers the shop's own channels, including the till", () => {
    // Understating this would be worse than the ambiguity it replaces.
    expect(saas.bodyHtml).toMatch(/online ordering website/i);
    expect(saas.bodyHtml).toMatch(/till/i);
  });

  it("keeps the carve-out inside the commission clause", () => {
    // No commission agreed means no commission clause — and nothing to carve
    // out. The exclusion must live inside the same {{#commission}} block, or a
    // fee-free contract would carry a paragraph about a fee it never charges.
    const block = saas.bodyHtml.slice(
      saas.bodyHtml.indexOf("{{#commission}}"),
      saas.bodyHtml.indexOf("{{/commission}}"),
    );
    expect(block).toMatch(/third-party marketplace/i);
  });

  it("does not renumber the clauses around it", () => {
    // 11.4 cites clause 3.7 and 5.4 cites clause 3. Inserting a new numbered
    // clause here would silently break both.
    expect(saas.bodyHtml).toContain("3.7 <strong>Price changes.</strong>");
    expect(saas.bodyHtml).toContain("clauses 3.7 and 2.11");
  });
});
