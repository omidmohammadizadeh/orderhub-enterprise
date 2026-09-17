import { UberEatsController } from "../ubereats.controller";

// Which Uber app are we actually pointed at?
//
// Uber decides where to send the merchant's consent screen from the client_id.
// A sandbox app routes to sandbox-login.uber.com, where a real merchant
// account does not exist — they sign in and the page simply reloads. From our
// side that is invisible: the token mint succeeds, every scope reads granted,
// and the only clue is a host buried in a redirect.
//
// So the probe reports the last four characters of the client id and the
// authorize host. Enough to compare against Uber's developer dashboard and to
// quote in a support ticket; not enough to be a credential.

function controller(opts: { clientId?: string; authBase?: string } = {}) {
  const c = Object.create(UberEatsController.prototype) as any;
  c.client = {
    configured: true,
    clientId: opts.clientId ?? "abcd1234efgh5678",
    authBase: opts.authBase ?? "https://auth.uber.com/oauth/v2",
    getToken: jest.fn().mockResolvedValue("tok"),
    grantedScopes: jest.fn().mockResolvedValue([]),
  };
  c.oauth = { redirectUri: "https://api.example.com/cb" };
  return c;
}

describe("Uber Eats health — identifying the app", () => {
  it("reports only the last four characters of the client id", async () => {
    const c = controller({ clientId: "abcd1234efgh5678" });
    const out = await c.health();

    expect(out.clientIdEndsWith).toBe("5678");
    // The whole point: the probe is public.
    expect(JSON.stringify(out)).not.toContain("abcd1234efgh");
  });

  it("reports the authorize host, which is where sandbox shows up", async () => {
    const c = controller();
    const out = await c.health();

    expect(out.authorizeHost).toBe("auth.uber.com");
  });

  it("copes with a client id shorter than four characters", async () => {
    const c = controller({ clientId: "ab" });
    const out = await c.health();

    expect(out.clientIdEndsWith).toBe("ab");
  });
});
