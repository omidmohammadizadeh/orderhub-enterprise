import { JetGoClientService } from "../jet-go-client.service";

// JET Go serves the Keycloak token and the delivery API from DIFFERENT hosts,
// and the host depends on the market. Point UK credentials at the Canadian host
// and every call 401s; use the token host for a delivery call and every call
// 404s. Neither failure says what it actually is, so it is pinned here.

const c = new JetGoClientService();
const creds = (market: string, environment = "sandbox") =>
  ({ clientId: "id", clientSecret: "secret", market, environment }) as any;

describe("JET Go host resolution", () => {
  it("uses api-…/api-daas-… as two different hosts", () => {
    expect(c.authBase(creds("UK"))).toBe("https://api-staguk.skipthedishes.com");
    expect(c.apiBase(creds("UK"))).toBe("https://api-daas-staguk.skipthedishes.com");
  });

  it.each([
    ["UK", "sandbox", "api-staguk", "api-daas-staguk"],
    ["UK", "production", "api-produk", "api-daas-produk"],
    ["CA", "sandbox", "api-staging", "api-daas-staging"],
    ["CA", "production", "api", "api-daas"],
    ["AU", "sandbox", "api-stagaus", "api-daas-stagaus"],
    ["AU", "production", "api-prodaus", "api-daas-prodaus"],
  ])("maps %s/%s", (market, env, auth, api) => {
    expect(c.authBase(creds(market, env))).toBe(`https://${auth}.skipthedishes.com`);
    expect(c.apiBase(creds(market, env))).toBe(`https://${api}.skipthedishes.com`);
  });

  // EU is the odd one out in JET's own table: a DOT before the environment
  // segment where every other market uses a dash.
  it("keeps the EU dot instead of a dash", () => {
    expect(c.authBase(creds("EU"))).toBe("https://api.stageu1.skipthedishes.com");
    expect(c.apiBase(creds("EU"))).toBe("https://api-daas.stageu1.skipthedishes.com");
    expect(c.apiBase(creds("EU", "production"))).toBe(
      "https://api-daas.prodeu1.skipthedishes.com",
    );
  });

  it("falls back to UK rather than building an invalid host", () => {
    expect(c.apiBase(creds("nonsense"))).toBe("https://api-daas-staguk.skipthedishes.com");
  });

  it("treats anything that isn't 'production' as sandbox", () => {
    expect(c.apiBase(creds("UK", "prod"))).toBe("https://api-daas-staguk.skipthedishes.com");
  });
});
