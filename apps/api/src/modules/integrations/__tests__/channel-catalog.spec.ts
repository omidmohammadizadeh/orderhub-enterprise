import {
  channelsForCountry,
  visibleChannelIds,
  CHANNELS_BY_COUNTRY,
} from "@orderhub/shared";

const ids = (country: string) => channelsForCountry(country).map((c) => c.id);

describe("channelsForCountry", () => {
  it("offers the UK set to a UK shop and no Gulf marketplaces", () => {
    expect(ids("GB")).toEqual(
      expect.arrayContaining(["JUST_EAT", "UBER_EATS", "DELIVEROO"]),
    );
    expect(ids("GB")).not.toContain("CAREEM");
    expect(ids("GB")).not.toContain("TALABAT");
  });

  it("offers the Gulf set to a UAE shop and no UK marketplaces", () => {
    // Every channel needs credentials and a store id, so offering an
    // unavailable one invites an afternoon configuring something that cannot
    // work. That is the point of the whole feature.
    expect(ids("AE")).toEqual(expect.arrayContaining(["TALABAT", "CAREEM"]));
    expect(ids("AE")).not.toContain("JUST_EAT");
  });

  it("offers Deliveroo in the Gulf, because it trades there", () => {
    // Deliveroo runs across Dubai, Abu Dhabi and Sharjah. An earlier version
    // of this test asserted the opposite on the strength of a wrong claim
    // about it withdrawing in 2024 — which is how a mistake gets locked in.
    for (const c of ["AE", "SA", "KW", "QA", "BH", "OM"]) {
      expect(ids(c)).toContain("DELIVEROO");
    }
  });

  it("does not offer Uber Eats in the Gulf", () => {
    // Uber Eats folded into Careem, which Uber owns. If that changes, change
    // the catalog with a source rather than from memory.
    for (const c of ["AE", "SA", "KW"]) {
      expect(ids(c)).not.toContain("UBER_EATS");
    }
  });

  it("offers a brand's own storefront everywhere, including unknown countries", () => {
    expect(ids("GB")).toContain("DIRECT_ONLINE");
    expect(ids("AE")).toContain("DIRECT_ONLINE");
    expect(ids("ZZ")).toEqual(["DIRECT_ONLINE"]);
    expect(ids("")).toEqual(["DIRECT_ONLINE"]);
  });

  it("is case and whitespace tolerant — country is a free-text column", () => {
    expect(ids(" ae ")).toEqual(ids("AE"));
  });

  it("lists every Talabat market we intend to sell into", () => {
    for (const c of ["AE", "SA", "KW", "QA", "BH", "OM", "JO", "EG"]) {
      expect(CHANNELS_BY_COUNTRY[c]).toBeDefined();
    }
  });
});

describe("visibleChannelIds — never hide a live connection", () => {
  it("shows a connection the country list would otherwise omit", () => {
    // Hiding it would not stop the orders arriving. It would only remove the
    // one screen that can turn them off.
    const out = visibleChannelIds("AE", ["UBER_EATS"]);
    expect(out).toContain("UBER_EATS");
    expect(out).toEqual(expect.arrayContaining(["CAREEM", "TALABAT"]));
  });

  it("does not duplicate a channel the country already offers", () => {
    const out = visibleChannelIds("GB", ["DELIVEROO", "JUST_EAT"]);
    expect(out.filter((i) => i === "DELIVEROO")).toHaveLength(1);
  });

  it("puts the country's own channels first, carried-over ones after", () => {
    const out = visibleChannelIds("GB", ["CAREEM"]);
    expect(out[0]).toBe("DIRECT_ONLINE");
    expect(out[out.length - 1]).toBe("CAREEM");
  });

  it("matches the plain country list when nothing is connected", () => {
    expect(visibleChannelIds("AE", [])).toEqual(ids("AE"));
    expect(visibleChannelIds("AE")).toEqual(ids("AE"));
  });

  it("ignores a platform the catalog has never heard of", () => {
    expect(visibleChannelIds("GB", ["WOLT", ""])).toEqual(ids("GB"));
  });
});
