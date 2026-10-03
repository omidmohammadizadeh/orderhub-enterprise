import type { AxiosStatic } from "axios";

// The reported bug, driven through the REAL interceptor.
//
// "Driver app logs them out after a few minutes." A 401 on any call makes the
// app refresh its token; the session used to be cleared whenever that refresh
// failed for ANY reason. On a phone, failing is normal — tunnels, carrier
// handovers, the API restarting on a deploy, the refresh endpoint's own 30/min
// rate limit — so drivers were thrown to the login screen mid-delivery.
//
// session-policy.spec.ts covers the decision; this covers the wiring: what
// actually happens to the stored tokens when a refresh fails.

const TOKEN_KEY = "orderhub.driver.tokens";

/** In-memory stand-in for the phone's secure store. */
const store = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
}));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: "http://api.test" } } },
}));

const signedIn = () =>
  JSON.stringify({ accessToken: "access-old", refreshToken: "refresh-old" });

/**
 * Load a fresh copy of the module so its in-memory token state is clean.
 *
 * axios is imported INSIDE the isolated registry and handed back: an isolated
 * module gets its own copy, so spying on the test file's axios would do
 * nothing and the refresh would really try to reach the network — which fails,
 * which looks exactly like the transient failure under test. A test that
 * passes for the wrong reason is worse than no test.
 */
async function freshAuth(): Promise<{
  auth: typeof import("./auth");
  axios: AxiosStatic;
}> {
  let mod!: typeof import("./auth");
  let ax!: AxiosStatic;
  await jest.isolateModulesAsync(async () => {
    ax = (await import("axios")).default as unknown as AxiosStatic;
    mod = await import("./auth");
  });
  // The foreground owns rotation; without this we'd be testing the background
  // task's path, which never refreshes by design.
  mod.claimTokenRotation();
  // Every call 401s, as it would with an expired access token.
  mod.api.defaults.adapter = async (config) => {
    const err: any = new Error("Request failed with status code 401");
    err.config = config;
    err.response = { status: 401, data: {}, headers: {}, config };
    throw err;
  };
  return { auth: mod, axios: ax };
}

beforeEach(() => {
  store.clear();
  store.set(TOKEN_KEY, signedIn());
  jest.restoreAllMocks();
});

describe("a refresh that fails because the phone could not reach the server", () => {
  it.each([
    ["no signal", () => Promise.reject(new Error("Network Error"))],
    [
      "the API restarting mid-deploy",
      () => Promise.reject(Object.assign(new Error("502"), { response: { status: 502 } })),
    ],
    [
      "the refresh endpoint rate-limiting",
      () => Promise.reject(Object.assign(new Error("429"), { response: { status: 429 } })),
    ],
  ])("keeps the driver signed in: %s", async (_why, refreshOutcome) => {
    const { auth, axios } = await freshAuth();
    jest.spyOn(axios, "post").mockImplementation(refreshOutcome as any);

    await expect(auth.api.get("/v1/driver/me")).rejects.toBeDefined();

    // The whole point: the tokens are still on the phone, so the driver is
    // still signed in and the next poll will try again.
    expect(store.get(TOKEN_KEY)).toBe(signedIn());
  });
});

describe("a refresh the auth server actually rejects", () => {
  it("signs the driver out", async () => {
    const { auth, axios } = await freshAuth();
    jest
      .spyOn(axios, "post")
      .mockRejectedValue(Object.assign(new Error("401"), { response: { status: 401 } }));

    await expect(auth.api.get("/v1/driver/me")).rejects.toBeDefined();

    expect(store.has(TOKEN_KEY)).toBe(false);
  });
});

describe("a refresh that works", () => {
  it("stores the new pair and replays the request with it", async () => {
    const { auth, axios } = await freshAuth();
    jest.spyOn(axios, "post").mockResolvedValue({
      data: { accessToken: "access-new", refreshToken: "refresh-new" },
    } as any);

    const seen: string[] = [];
    let first = true;
    auth.api.defaults.adapter = async (config) => {
      seen.push(String(config.headers?.Authorization ?? ""));
      if (first) {
        first = false;
        const err: any = new Error("401");
        err.config = config;
        err.response = { status: 401, data: {}, headers: {}, config };
        throw err;
      }
      return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config } as any;
    };

    const res = await auth.api.get("/v1/driver/me");

    expect(res.data).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer access-old", "Bearer access-new"]);
    expect(JSON.parse(store.get(TOKEN_KEY)!)).toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });
});

describe("the background location task", () => {
  it("never refreshes, so it cannot revoke the foreground's token", async () => {
    let mod!: typeof import("./auth");
    let ax!: AxiosStatic;
    await jest.isolateModulesAsync(async () => {
      ax = (await import("axios")).default as unknown as AxiosStatic;
      mod = await import("./auth");
    });
    // No claimTokenRotation() — this is the headless context.
    mod.api.defaults.adapter = async (config) => {
      const err: any = new Error("401");
      err.config = config;
      err.response = { status: 401, data: {}, headers: {}, config };
      throw err;
    };
    const post = jest.spyOn(ax, "post");

    await expect(mod.api.post("/v1/driver/ping", {})).rejects.toBeDefined();

    expect(post).not.toHaveBeenCalled();
    // And it must not sign anyone out either.
    expect(store.get(TOKEN_KEY)).toBe(signedIn());
  });
});
