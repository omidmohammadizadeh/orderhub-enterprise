import { distilHtml } from "../ai-menu.service";

describe("distilHtml (saved web-page menu import)", () => {
  it("extracts __NEXT_DATA__ JSON (Deliveroo-style saved page)", () => {
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"menu":{"items":[{"name":"Chicken Gyros","priceInMinorUnits":1099}]}}}</script></head><body><div>Chicken Gyros £10.99</div></body></html>`;
    const out = distilHtml(html);
    expect(out).toContain("EMBEDDED PAGE DATA (JSON)");
    expect(out).toContain("Chicken Gyros");
    expect(out).toContain("1099");
    expect(out).toContain("VISIBLE PAGE TEXT");
  });

  it("strips scripts/styles/tags from visible text", () => {
    const html = `<html><head><style>.x{color:red}</style></head><body><script>var track=1;</script><h1>Pizzas</h1><p>Margherita &amp; more — £8.50</p></body></html>`;
    const out = distilHtml(html);
    expect(out).toContain("Pizzas");
    expect(out).toContain("Margherita & more");
    expect(out).not.toContain("track=1");
    expect(out).not.toContain("color:red");
  });

  it("decodes quoted-printable MHTML (Chrome 'Save page' default)", () => {
    const mhtml = [
      "Content-Type: multipart/related; boundary=x",
      "",
      "--x",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<div>Donner Wrap =C2=A39.50 with garlic=",
      "\r\n sauce</div>",
    ].join("\r\n");
    const out = distilHtml(mhtml);
    expect(out).toContain("Donner Wrap");
    // =C2=A3 is the UTF-8 escape for £; soft line break must be joined.
    expect(out).toContain("9.50 with garlic sauce");
  });

  it("caps output length", () => {
    const big = `<body>${"menu item ".repeat(100_000)}</body>`;
    expect(distilHtml(big).length).toBeLessThanOrEqual(180_000);
  });
});
