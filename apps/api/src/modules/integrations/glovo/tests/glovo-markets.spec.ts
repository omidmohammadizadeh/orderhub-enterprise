import {
  channelsForCountry,
  currencyDecimals,
  currencyForCountry,
  resolveCountryCode,
  SUPPORTED_COUNTRIES,
  timezoneForCountry,
  visibleChannelIds,
  GLOVO_COUNTRIES,
} from "@orderhub/shared";

// Glovo trades in none of the countries OrderHub supported before it, so a
// shop could not even BE in a Glovo market. These pin the new markets — and
// pin that the existing ones did not move.

describe("Glovo markets", () => {
  it("a Spanish shop sees direct ordering and Glovo, nothing else", () => {
    expect(channelsForCountry("ES").map((c) => c.id)).toEqual(["DIRECT_ONLINE", "GLOVO"]);
    expect(channelsForCountry("Spain").map((c) => c.id)).toContain("GLOVO");
  });

  it("every Glovo country is pickable, priced and scheduled", () => {
    for (const c of GLOVO_COUNTRIES) {
      expect(SUPPORTED_COUNTRIES.some((s) => s.code === c)).toBe(true);
      expect(resolveCountryCode(c)).toBe(c);
      expect(timezoneForCountry(c)).not.toBe("Europe/London");
      expect(channelsForCountry(c).map((x) => x.id)).toContain("GLOVO");
    }
  });

  it("currencies follow the country, with the right number of decimals", () => {
    expect(currencyForCountry("ES")).toBe("EUR");
    expect(currencyForCountry("PL")).toBe("PLN");
    expect(currencyForCountry("MA")).toBe("MAD");
    expect(currencyDecimals("UGX")).toBe(0);
    expect(currencyDecimals("XOF")).toBe(0);
    expect(currencyDecimals("TND")).toBe(3);
  });

  it("does not change the UK, Ireland or the Gulf", () => {
    expect(channelsForCountry("GB").map((c) => c.id)).not.toContain("GLOVO");
    expect(channelsForCountry("AE").map((c) => c.id)).toEqual(["DIRECT_ONLINE", "TALABAT", "CAREEM", "DELIVEROO"]);
    expect(currencyForCountry("GB")).toBe("GBP");
    expect(timezoneForCountry("GB")).toBe("Europe/London");
  });

  it("a UK shop with a live Glovo connection can still see it (to disconnect it)", () => {
    expect(visibleChannelIds("GB", ["GLOVO"])).toContain("GLOVO");
  });
});
