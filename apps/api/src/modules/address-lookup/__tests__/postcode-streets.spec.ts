// The postcode → street step, which is the one a phone caller actually feels.
//
// A live call proved the old shape could not work: Overpass fails to CONNECT
// from Render's outbound IPs ("fetch failed", not a timeout), and the
// Nominatim fallback only started once Overpass had given up — behind five
// sequential 1.1s policy gaps. Four and a half seconds of deliberate waiting
// before the first syllable. These lock in the shape that replaced it.

import {
  GooglePostcodeProvider,
  firstNonEmpty,
} from "../providers/postcode-providers";
import {
  cacheStreets,
  clearStreetCache,
  getCachedStreets,
} from "../providers/postcode-street-cache";

describe("firstNonEmpty", () => {
  it("takes the first task that actually returns something, not the first to finish", async () => {
    const out = await firstNonEmpty<string>(
      [
        () => new Promise((r) => setTimeout(() => r([]), 5)), // fast shrug
        () => new Promise((r) => setTimeout(() => r(["Sunningdale Drive"]), 30)),
      ],
      500,
    );
    expect(out).toEqual(["Sunningdale Drive"]);
  });

  it("does not let one dead endpoint sink the others", async () => {
    const out = await firstNonEmpty<string>(
      [
        () => Promise.reject(new Error("fetch failed")), // overpass, from Render
        () => Promise.resolve(["Follingsby Drive"]),
      ],
      500,
    );
    expect(out).toEqual(["Follingsby Drive"]);
  });

  it("gives up at the deadline rather than holding the call open", async () => {
    const started = Date.now();
    const out = await firstNonEmpty<string>(
      [
        () =>
          new Promise((r) => {
            const t = setTimeout(() => r(["too late"]), 5000);
            (t as any).unref?.();
          }),
      ],
      60,
    );
    expect(out).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves empty once every task has shrugged, without waiting out the clock", async () => {
    const started = Date.now();
    const out = await firstNonEmpty<string>(
      [() => Promise.resolve([]), () => Promise.resolve([])],
      5000,
    );
    expect(out).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("street cache", () => {
  beforeEach(() => clearStreetCache());

  it("is postcode-shape agnostic — the caller says it however they say it", () => {
    cacheStreets("NE372LL", { streets: ["Sunningdale Drive"], city: "Sunderland" });
    expect(getCachedStreets("ne37 2ll")?.streets).toEqual(["Sunningdale Drive"]);
  });

  it("never caches a failure — a bad minute must not become a bad week", () => {
    cacheStreets("NE372LL", { streets: [] });
    expect(getCachedStreets("NE372LL")).toBeUndefined();
  });
});

describe("GooglePostcodeProvider", () => {
  const OLD_KEY = process.env.GOOGLE_MAPS_API_KEY;
  let calls: string[] = [];

  const mockFetch = (bodies: any[]) => {
    let i = 0;
    (global as any).fetch = jest.fn(async (url: string) => {
      calls.push(String(url));
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    });
  };

  beforeEach(() => {
    calls = [];
    clearStreetCache();
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = OLD_KEY;
    delete (global as any).fetch;
  });

  it("only turns on when a server key is present", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(new GooglePostcodeProvider().isConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    expect(new GooglePostcodeProvider().isConfigured()).toBe(true);
  });

  it("reverse-geocodes the centroid when the postcode alone names no street", async () => {
    mockFetch([
      {
        status: "OK",
        results: [
          {
            address_components: [
              { long_name: "Washington", short_name: "Washington", types: ["postal_town"] },
              { long_name: "NE37 2LL", short_name: "NE37 2LL", types: ["postal_code"] },
            ],
            geometry: { location: { lat: 54.9, lng: -1.53 } },
          },
        ],
      },
      {
        status: "OK",
        results: [
          {
            address_components: [
              { long_name: "Sunningdale Drive", short_name: "Sunningdale Dr", types: ["route"] },
            ],
          },
        ],
      },
    ]);

    const out = await new GooglePostcodeProvider().searchByPostcode("NE372LL");
    expect(out.map((s) => s.line1)).toEqual(["Sunningdale Drive"]);
    expect(out[0].city).toBe("Washington");
    expect(out[0].postcode).toBe("NE37 2LL");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("latlng=54.9,-1.53");
  });

  it("skips the second call when the first already named the street", async () => {
    mockFetch([
      {
        status: "OK",
        results: [
          {
            address_components: [
              { long_name: "Follingsby Drive", short_name: "Follingsby Dr", types: ["route"] },
              { long_name: "Gateshead", short_name: "Gateshead", types: ["postal_town"] },
            ],
            geometry: { location: { lat: 54.9, lng: -1.5 } },
          },
        ],
      },
    ]);

    const out = await new GooglePostcodeProvider().searchByPostcode("NE100AA");
    expect(out.map((s) => s.line1)).toEqual(["Follingsby Drive"]);
    expect(calls).toHaveLength(1);
  });

  it("answers the second caller from memory instead of paying Google twice", async () => {
    mockFetch([
      {
        status: "OK",
        results: [
          {
            address_components: [
              { long_name: "Sunningdale Drive", short_name: "Sunningdale Dr", types: ["route"] },
            ],
            geometry: { location: { lat: 54.9, lng: -1.53 } },
          },
        ],
      },
    ]);

    const provider = new GooglePostcodeProvider();
    await provider.searchByPostcode("NE372LL");
    const before = calls.length;
    const again = await provider.searchByPostcode("NE372LL");
    expect(again.map((s) => s.line1)).toEqual(["Sunningdale Drive"]);
    expect(calls).toHaveLength(before);
  });

  it("shouts about a misconfigured key rather than quietly returning nothing", async () => {
    mockFetch([{ status: "REQUEST_DENIED", error_message: "API key not authorized" }]);
    await expect(
      new GooglePostcodeProvider().searchByPostcode("NE372LL"),
    ).rejects.toThrow(/REQUEST_DENIED/);
  });

  it("treats an unknown postcode as empty, so the chain falls through", async () => {
    mockFetch([{ status: "ZERO_RESULTS", results: [] }]);
    expect(await new GooglePostcodeProvider().searchByPostcode("ZZ991ZZ")).toEqual([]);
  });
});
