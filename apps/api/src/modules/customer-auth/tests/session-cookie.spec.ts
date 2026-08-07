// Staying signed in between visits.
//
// The session used to live only in localStorage, which is not durable on the
// browsers takeaway customers actually use: iOS Safari purges script-writable
// storage after 7 days without a first-party interaction, and the in-app
// webview a WhatsApp or Instagram link opens in often starts empty every time.
// Neither is a token-expiry problem, so a longer TTL alone would not have
// fixed it — the token has to survive somewhere else too.

import { CUSTOMER_TOKEN_COOKIE } from "../customer-auth.service";
import { CustomerAuthController } from "../customer-auth.controller";
import { fromSessionCookie } from "../customer-jwt.strategy";

const makeRes = () => {
  const calls: any[] = [];
  return {
    calls,
    cookie: (name: string, value: string, opts: any) =>
      calls.push({ kind: "set", name, value, opts }),
    clearCookie: (name: string, opts: any) =>
      calls.push({ kind: "clear", name, opts }),
  } as any;
};

const controller = (svc: any = {}) =>
  new CustomerAuthController(svc, { get: () => "" } as any);

describe("customer session cookie", () => {
  it("is set on login so the session survives storage being wiped", async () => {
    const res = makeRes();
    const c = controller({
      login: async () => ({ accessToken: "jwt123", customer: { id: "c1" } }),
    });
    await c.login({ email: "a@b.co", password: "x" } as any, res);

    const set = res.calls.find((x: any) => x.kind === "set");
    expect(set.name).toBe(CUSTOMER_TOKEN_COOKIE);
    expect(set.value).toBe("jwt123");
  });

  it("is HttpOnly, Secure and SameSite=Lax", async () => {
    // Lax rather than Strict is load-bearing: most of these orders start by
    // following a link in from WhatsApp or a QR code, and Strict drops the
    // cookie on exactly that navigation.
    const res = makeRes();
    const c = controller({
      login: async () => ({ accessToken: "jwt123" }),
    });
    await c.login({ email: "a@b.co", password: "x" } as any, res);

    const { opts } = res.calls.find((x: any) => x.kind === "set");
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe("lax");
  });

  it("lasts a year", async () => {
    const res = makeRes();
    const c = controller({ login: async () => ({ accessToken: "j" }) });
    await c.login({ email: "a@b.co", password: "x" } as any, res);
    const { opts } = res.calls.find((x: any) => x.kind === "set");
    expect(opts.maxAge).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("is re-stamped by /me so the year slides", async () => {
    // Otherwise it would expire a year after the FIRST login however often
    // they came back — the flat-expiry bug the sliding token already fixed
    // for localStorage.
    const res = makeRes();
    const c = controller({
      signCustomerToken: async () => "fresh-jwt",
    });
    await c.me({ id: "c1" }, res);
    const set = res.calls.find((x: any) => x.kind === "set");
    expect(set.value).toBe("fresh-jwt");
  });

  it("is cleared on logout", async () => {
    // A session that outlives a deliberate sign-out is worse than the problem
    // the cookie was added to solve.
    const res = makeRes();
    await controller().logout(res);
    expect(res.calls.find((x: any) => x.kind === "clear").name).toBe(
      CUSTOMER_TOKEN_COOKIE,
    );
  });

  it("does not set a cookie when login returned no token", async () => {
    const res = makeRes();
    const c = controller({ login: async () => ({ pendingVerification: true }) });
    await c.login({ email: "a@b.co", password: "x" } as any, res);
    expect(res.calls).toHaveLength(0);
  });
});

describe("reading the session cookie off the request", () => {
  const read = (cookie?: string) =>
    fromSessionCookie({ headers: cookie ? { cookie } : {} });

  it("finds the token among other cookies", () => {
    expect(
      read(`_ga=1; ${CUSTOMER_TOKEN_COOKIE}=jwt123; other=2`),
    ).toBe("jwt123");
  });

  it("is not fooled by a cookie whose name merely ends the same way", () => {
    expect(read(`not_${CUSTOMER_TOKEN_COOKIE}=wrong`)).toBeNull();
  });

  it("returns null rather than throwing on a malformed header", () => {
    // A junk Cookie header must degrade to "not signed in", not a 500 on
    // every request the browser makes.
    expect(read("garbage")).toBeNull();
    expect(read("")).toBeNull();
    expect(read()).toBeNull();
    expect(fromSessionCookie(null)).toBeNull();
    expect(fromSessionCookie({ headers: { cookie: 42 } })).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(read(`${CUSTOMER_TOKEN_COOKIE}=a%2Eb`)).toBe("a.b");
  });
});
