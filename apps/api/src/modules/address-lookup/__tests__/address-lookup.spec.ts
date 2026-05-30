import { AddressLookupService } from "../address-lookup.service";
import type {
  PostcodeProvider,
  SearchProvider,
} from "../providers/types";

// Phase AM — provider-chain dispatch behaviour.
//
// The service itself owns no HTTP code — its job is to walk the configured
// chain and dispatch. These tests use stub providers to lock in:
//   • search() picks the first configured provider
//   • errors fall through to the next provider in the chain
//   • postcode chain skips empty results from paid providers so the
//     postcodes.io fallback still gets a chance
//   • everything falls back to "manual" when no provider can answer

const stubSearch = (
  id: any,
  opts: {
    configured?: boolean;
    suggestions?: any[];
    throws?: boolean;
  },
): SearchProvider => ({
  id,
  isConfigured: () => opts.configured ?? false,
  search: jest.fn(async () => {
    if (opts.throws) throw new Error("boom");
    return opts.suggestions ?? [];
  }),
});

const stubPostcode = (
  id: any,
  opts: {
    configured?: boolean;
    suggestions?: any[];
    throws?: boolean;
  },
): PostcodeProvider => ({
  id,
  isConfigured: () => opts.configured ?? false,
  searchByPostcode: jest.fn(async () => {
    if (opts.throws) throw new Error("boom");
    return opts.suggestions ?? [];
  }),
});

describe("AddressLookupService — search chain", () => {
  it("returns manual when no provider configured", async () => {
    const svc = new AddressLookupService([], []);
    const res = await svc.search("anywhere");
    expect(res.provider).toBe("manual");
    expect(res.suggestions).toEqual([]);
  });

  it("dispatches to the first configured provider", async () => {
    const google = stubSearch("google", {
      configured: true,
      suggestions: [{ id: "g1", label: "G1", line1: "g1", provider: "google" }],
    });
    const mapbox = stubSearch("mapbox", { configured: true });
    const svc = new AddressLookupService([google, mapbox], []);
    const res = await svc.search("Old Kent Road");
    expect(res.provider).toBe("google");
    expect(mapbox.search).not.toHaveBeenCalled();
  });

  it("falls through to the next provider on error", async () => {
    const google = stubSearch("google", { configured: true, throws: true });
    const mapbox = stubSearch("mapbox", {
      configured: true,
      suggestions: [{ id: "m1", label: "M1", line1: "m1", provider: "mapbox" }],
    });
    const svc = new AddressLookupService([google, mapbox], []);
    const res = await svc.search("Old Kent Road");
    expect(res.provider).toBe("mapbox");
  });

  it("skips unconfigured providers without calling them", async () => {
    const google = stubSearch("google", { configured: false });
    const mapbox = stubSearch("mapbox", {
      configured: true,
      suggestions: [{ id: "m1", label: "M1", line1: "m1", provider: "mapbox" }],
    });
    const svc = new AddressLookupService([google, mapbox], []);
    const res = await svc.search("Old Kent Road");
    expect(res.provider).toBe("mapbox");
    expect(google.search).not.toHaveBeenCalled();
  });
});

describe("AddressLookupService — postcode chain", () => {
  it("returns manual when no provider configured", async () => {
    const svc = new AddressLookupService([], []);
    const res = await svc.searchByPostcode("NE10 8YH");
    expect(res.provider).toBe("manual");
  });

  it("uses paid provider when it has results", async () => {
    const getaddress = stubPostcode("getaddress", {
      configured: true,
      suggestions: [
        { id: "1", label: "1 X", line1: "1 X", postcode: "NE108YH", provider: "getaddress" },
      ],
    });
    const postcodesIo = stubPostcode("postcodes_io", { configured: true });
    const svc = new AddressLookupService([], [getaddress, postcodesIo]);
    const res = await svc.searchByPostcode("NE10 8YH");
    expect(res.provider).toBe("getaddress");
    expect(postcodesIo.searchByPostcode).not.toHaveBeenCalled();
  });

  it("falls through to fallback when paid provider returns empty", async () => {
    const getaddress = stubPostcode("getaddress", {
      configured: true,
      suggestions: [],
    });
    const postcodesIo = stubPostcode("postcodes_io", {
      configured: true,
      suggestions: [
        { id: "pio:1", label: "Gateshead, NE10 8YH", line1: "", city: "Gateshead", postcode: "NE10 8YH", provider: "postcodes_io" },
      ],
    });
    const svc = new AddressLookupService([], [getaddress, postcodesIo]);
    const res = await svc.searchByPostcode("NE10 8YH");
    expect(res.provider).toBe("postcodes_io");
  });

  it("falls through to fallback when paid provider throws", async () => {
    const getaddress = stubPostcode("getaddress", { configured: true, throws: true });
    const postcodesIo = stubPostcode("postcodes_io", {
      configured: true,
      suggestions: [
        { id: "pio:1", label: "Gateshead, NE10 8YH", line1: "", postcode: "NE10 8YH", provider: "postcodes_io" },
      ],
    });
    const svc = new AddressLookupService([], [getaddress, postcodesIo]);
    const res = await svc.searchByPostcode("NE10 8YH");
    expect(res.provider).toBe("postcodes_io");
  });

  it("rejects too-short input without hitting any provider", async () => {
    const getaddress = stubPostcode("getaddress", { configured: true });
    const svc = new AddressLookupService([], [getaddress]);
    const res = await svc.searchByPostcode("NE1");
    expect(res.suggestions).toEqual([]);
    expect(getaddress.searchByPostcode).not.toHaveBeenCalled();
  });
});

describe("AddressLookupService — status diagnostic", () => {
  it("reports configured providers per chain", () => {
    const svc = new AddressLookupService(
      [
        stubSearch("google", { configured: false }),
        stubSearch("mapbox", { configured: true }),
      ],
      [
        stubPostcode("getaddress", { configured: false }),
        stubPostcode("postcodes_io", { configured: true }),
      ],
    );
    const status = svc.status();
    expect(status.searchProvider).toBe("mapbox");
    expect(status.postcodeProvider).toBe("postcodes_io");
    expect(status.configured.search).toEqual(["mapbox"]);
    expect(status.configured.postcode).toEqual(["postcodes_io"]);
  });
});
