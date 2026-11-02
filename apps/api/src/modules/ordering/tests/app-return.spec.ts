import { OrderingController } from "../ordering.controller";

const run = (scheme: any, to: any, ua: string) => {
  const res = { redirect: jest.fn() } as any;
  new OrderingController({} as any).appReturn(scheme, to, ua, res);
  return res.redirect.mock.calls[0];
};
const PAGE = "https://www.orderhubsolutions.com/order/pizza-uno/confirmation?orderId=o1&brand=b1";

describe("GET /v1/ordering/app-return", () => {
  it("sends Android into the app with an intent URL that falls back to the page", () => {
    const [code, url] = run("orderhub-pizzauno", PAGE, "Mozilla/5.0 (Linux; Android 14) Chrome/140");
    expect(code).toBe(302);
    expect(url).toBe(
      `intent://payment-return?to=${encodeURIComponent(PAGE)}#Intent;scheme=orderhub-pizzauno;` +
        `S.browser_fallback_url=${encodeURIComponent(PAGE + "&appReturn=orderhub-pizzauno")};end`,
    );
  });

  it("sends everyone else to the app scheme directly", () => {
    const [, url] = run("orderhub-pizzauno", PAGE, "Mozilla/5.0 (iPhone) AppleWebKit");
    expect(url).toBe(`orderhub-pizzauno://payment-return?to=${encodeURIComponent(PAGE)}`);
  });

  it("never redirects to a scheme it doesn't recognise, nor to a non-https page", () => {
    expect(run("javascript", PAGE, "Android")).toEqual([302, PAGE]);
    expect(run("orderhub-pizzauno", "javascript:alert(1)", "iPhone")[1]).toBe(
      `orderhub-pizzauno://payment-return?to=${encodeURIComponent("https://www.orderhubsolutions.com")}`,
    );
  });
});
