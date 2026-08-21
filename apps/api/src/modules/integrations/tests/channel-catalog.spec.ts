import {
  channelsForCountry,
  isChannelAvailableIn,
  CHANNELS,
  CHANNEL_COUNTRIES,
  visibleChannelIds,
} from "@orderhub/shared";

// The country filter on the Brands page is a correctness guard, not a
// convenience: every channel needs credentials and a store id, so offering one
// that can't exist in that country invites a misconfiguration that only shows
// up as a failed order later.

const ids = (country: string) => channelsForCountry(country).map((c) => c.id);

describe("channelsForCountry", () => {
  it("offers the UK marketplaces to a UK brand", () => {
    expect(ids("GB")).toEqual(
      expect.arrayContaining(["JUST_EAT", "UBER_EATS", "DELIVEROO"]),
    );
  });

  it("offers the Gulf marketplaces to a UAE brand", () => {
    expect(ids("AE")).toEqual(expect.arrayContaining(["CAREEM", "TALABAT", "DELIVEROO"]));
  });

  it("never offers Gulf channels in the UK", () => {
    expect(ids("GB")).not.toContain("CAREEM");
    expect(ids("GB")).not.toContain("TALABAT");
  });

  it("never offers UK-only channels in the UAE", () => {
    // Careem absorbed Uber's food business in the region, so Uber Eats is
    // deliberately absent rather than merely unlisted.
    expect(ids("AE")).not.toContain("UBER_EATS");
    expect(ids("AE")).not.toContain("JUST_EAT");
    expect(ids("AE")).not.toContain("STUART");
  });

  it("always offers our own storefront, in every country", () => {
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(ids(code)).toContain("DIRECT_ONLINE");
    }
  });

  it("keeps HubRise out — it is configured per location, not per brand", () => {
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(ids(code)).not.toContain("HUBRISE");
    }
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(ids(" ae ")).toEqual(ids("AE"));
  });

  it("falls back to just our own storefront for an unknown country", () => {
    // Better than showing everything: an unset country must not imply that
    // every marketplace on earth is connectable.
    expect(ids("ZZ")).toEqual(["DIRECT_ONLINE"]);
    expect(channelsForCountry(null).map((c) => c.id)).toEqual(["DIRECT_ONLINE"]);
    expect(channelsForCountry("").map((c) => c.id)).toEqual(["DIRECT_ONLINE"]);
  });
});

describe("isChannelAvailableIn", () => {
  it("agrees with the list it filters", () => {
    expect(isChannelAvailableIn("CAREEM", "AE")).toBe(true);
    expect(isChannelAvailableIn("CAREEM", "GB")).toBe(false);
    expect(isChannelAvailableIn("HUBRISE", "GB")).toBe(false);
  });
});

describe("catalog integrity", () => {
  it("has no duplicate channel ids", () => {
    const seen = CHANNELS.map((c) => c.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("lists every country that some channel names", () => {
    // A channel naming a country the filter can't select is unreachable.
    const known = new Set(CHANNEL_COUNTRIES.map((c) => c.code));
    for (const c of CHANNELS) {
      for (const code of c.countries) {
        expect(known.has(code)).toBe(true);
      }
    }
  });

  it("gives every listed country at least one marketplace", () => {
    // Otherwise the filter offers a country whose only option is our own
    // storefront — which is a channel you get anyway.
    for (const { code } of CHANNEL_COUNTRIES) {
      expect(
        channelsForCountry(code).filter((c) => c.kind !== "direct").length,
      ).toBeGreaterThan(0);
    }
  });
});

// The country filter is a page-level control, so it must never be able to
// conceal a channel that is currently taking orders. Nothing is written when
// it changes — but an invisible connection is an unmanageable one, and reads
// to the operator as a lost connection.
describe("visibleChannelIds — the filter can add, never hide", () => {
  it("shows a live UK connection while viewing UAE channels", () => {
    const ids = visibleChannelIds("AE", ["UBER_EATS"]);
    expect(ids).toContain("UBER_EATS");
    // ...without dropping what the country legitimately offers.
    expect(ids).toEqual(expect.arrayContaining(["CAREEM", "TALABAT"]));
  });

  it("does not duplicate a connection the country already offers", () => {
    const ids = visibleChannelIds("GB", ["UBER_EATS", "DELIVEROO"]);
    expect(ids.filter((i) => i === "UBER_EATS")).toHaveLength(1);
    expect(ids.filter((i) => i === "DELIVEROO")).toHaveLength(1);
  });

  it("matches the plain country list when nothing is connected", () => {
    expect(visibleChannelIds("GB", [])).toEqual(
      channelsForCountry("GB").map((c) => c.id),
    );
  });

  it("keeps the country's channels first, with carried-over ones after", () => {
    const ids = visibleChannelIds("GB", ["CAREEM"]);
    expect(ids[0]).toBe("DIRECT_ONLINE");
    expect(ids[ids.length - 1]).toBe("CAREEM");
  });

  it("still keeps location-level HubRise out, even when connected", () => {
    expect(visibleChannelIds("GB", ["HUBRISE"])).not.toContain("HUBRISE");
  });

  it("ignores a platform the catalog has never heard of", () => {
    expect(visibleChannelIds("GB", ["WOLT", ""])).toEqual(
      channelsForCountry("GB").map((c) => c.id),
    );
  });
});
