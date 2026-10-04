import {
  EMAIL_TEMPLATES,
  STOREFRONT_LINK,
  personalise,
  renderEmail,
  resolveEmailUrl,
  type EmailDesign,
} from "@orderhub/shared";

const ctx = {
  brandName: "Pizza Uno",
  logoUrl: "https://cdn.example.com/logo.png",
  storefrontUrl: "https://www.orderhubsolutions.com/order/pizza-uno",
  footerAddress: "1 High St, London, N1 1AA",
  unsubscribeUrl: "https://www.orderhubsolutions.com/email/unsubscribe?t=abc",
};

const design = (blocks: any[]): EmailDesign => ({
  theme: {
    primaryColor: "#ff0000",
    buttonTextColor: "#ffffff",
    backgroundColor: "#eeeeee",
    cardColor: "#ffffff",
    textColor: "#111111",
  },
  blocks,
});

describe("renderEmail", () => {
  it("escapes restaurant-written text so it can't inject markup", () => {
    const { html } = renderEmail(
      design([{ id: "t", type: "text", text: `<script>alert(1)</script> & "quotes"` }]),
      ctx,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("always carries the unsubscribe link and the postal address, even with no blocks", () => {
    const out = renderEmail(design([]), ctx);
    expect(out.html).toContain(ctx.unsubscribeUrl);
    expect(out.html).toContain("1 High St, London, N1 1AA");
    expect(out.text).toContain(`Unsubscribe: ${ctx.unsubscribeUrl}`);
  });

  it("records every link in render order and routes it through trackLink", () => {
    const seen: number[] = [];
    const out = renderEmail(
      design([
        { id: "b1", type: "button", label: "Order", url: STOREFRONT_LINK },
        { id: "b2", type: "button", label: "Insta", url: "https://instagram.com/pizzauno" },
      ]),
      { ...ctx, trackLink: (_l, i) => (seen.push(i), `https://t.example/${i}`) },
    );
    expect(out.links).toEqual([
      { url: ctx.storefrontUrl, storefront: true },
      { url: "https://instagram.com/pizzauno", storefront: false },
    ]);
    expect(seen).toEqual([0, 1]);
    expect(out.html).toContain('href="https://t.example/0"');
    expect(out.html).toContain('href="https://t.example/1"');
    // The unsubscribe link is never click-tracked.
    expect(out.html).toContain(`href="${ctx.unsubscribeUrl}"`);
  });

  it("turns a javascript: link into the storefront", () => {
    expect(resolveEmailUrl("javascript:alert(1)", ctx.storefrontUrl)).toEqual({
      url: ctx.storefrontUrl,
      storefront: true,
    });
    expect(resolveEmailUrl("pizzauno.co.uk", ctx.storefrontUrl).url).toBe("https://pizzauno.co.uk");
  });

  it("ignores a theme colour that isn't a hex colour", () => {
    const d = design([{ id: "b", type: "button", label: "Go", url: STOREFRONT_LINK }]);
    (d.theme as any).primaryColor = "red;background:url(x)";
    const { html } = renderEmail(d, ctx);
    expect(html).not.toContain("url(x)");
  });

  it("personalises with a friendly fallback and drops unknown tags", () => {
    expect(personalise("Hi {{first_name}}!", { firstName: "" })).toBe("Hi there!");
    expect(personalise("Hi {{ FirstName }} {{oops}}", { firstName: "Sam" })).toBe("Hi Sam ");
    expect(personalise("From {{brand_name}}", { brandName: "Uno" })).toBe("From Uno");
  });

  it("builds and renders every starter template", () => {
    for (const t of EMAIL_TEMPLATES) {
      const d = t.build({
        brandName: "Pizza Uno",
        products: [{ id: "1", name: "Margherita", price: "£9.99", imageUrl: "https://x/y.jpg" }],
        heroImageUrl: "https://x/hero.jpg",
      });
      const out = renderEmail(d, { ...ctx, firstName: "Sam" });
      expect(out.html).toContain("<!DOCTYPE html>");
      expect(out.html).not.toMatch(/\{\{/);
      expect(out.links.length).toBeGreaterThan(0);
    }
  });
});
