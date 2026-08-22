import {
  currencyForCountry,
  currencyDecimals,
  formatMoney,
  currencySymbol,
  timezoneForCountry,
  tenderNotesFor,
} from "@orderhub/shared";

describe("currencyForCountry", () => {
  it("maps the markets we are opening in", () => {
    expect(currencyForCountry("AE")).toBe("AED");
    expect(currencyForCountry("SA")).toBe("SAR");
    expect(currencyForCountry("KW")).toBe("KWD");
    expect(currencyForCountry("GB")).toBe("GBP");
  });

  it("is case and whitespace tolerant — country comes from a text column", () => {
    expect(currencyForCountry(" ae ")).toBe("AED");
    expect(currencyForCountry("gb")).toBe("GBP");
  });

  it("falls back to GBP rather than throwing on an unknown country", () => {
    expect(currencyForCountry("ZZ")).toBe("GBP");
    expect(currencyForCountry(null)).toBe("GBP");
    expect(currencyForCountry("")).toBe("GBP");
  });
});

// The trap that makes .toFixed(2) unsafe across a Gulf rollout.
describe("currencyDecimals", () => {
  it("gives the Gulf dinars THREE places, not two", () => {
    // 1.250 KWD is one dinar 250 fils. Rendered as "1.25" it is a different
    // amount of money, and every price on the menu would be wrong.
    for (const c of ["KWD", "BHD", "OMR", "JOD"]) {
      expect(currencyDecimals(c)).toBe(3);
    }
  });

  it("gives zero-decimal currencies none", () => {
    expect(currencyDecimals("IQD")).toBe(0);
    expect(currencyDecimals("JPY")).toBe(0);
  });

  it("gives the ordinary ones two", () => {
    expect(currencyDecimals("GBP")).toBe(2);
    expect(currencyDecimals("AED")).toBe(2);
    expect(currencyDecimals(undefined)).toBe(2);
  });
});

describe("formatMoney", () => {
  it("keeps three decimals for a dinar in compact mode", () => {
    expect(formatMoney(1.25, "KWD", { compact: true })).toBe("KWD 1.250");
  });

  it("formats pounds and dirhams compactly for a receipt column", () => {
    expect(formatMoney(6.49, "GBP", { compact: true })).toBe("£6.49");
    expect(formatMoney(24, "AED", { compact: true })).toBe("AED 24.00");
  });

  it("shows the right currency in full formatting", () => {
    // Placement and separators are the platform's business; what must be true
    // is that the AMOUNT and the CURRENCY are both right.
    const aed = formatMoney(1234.5, "AED");
    expect(aed).toMatch(/1,?234\.50/);
    expect(aed.toUpperCase()).toContain("AED");
  });

  it("treats a missing or unparseable amount as zero, never NaN on a ticket", () => {
    expect(formatMoney(null, "GBP", { compact: true })).toBe("£0.00");
    expect(formatMoney("abc" as any, "GBP", { compact: true })).toBe("£0.00");
    expect(formatMoney(undefined, "AED", { compact: true })).toBe("AED 0.00");
  });

  it("does not throw on a currency code it has never seen", () => {
    expect(() => formatMoney(5, "ZZZ")).not.toThrow();
    expect(formatMoney(5, "ZZZ", { compact: true })).toBe("ZZZ 5.00");
  });

  it("defaults to GBP so existing UK callers are unchanged", () => {
    expect(formatMoney(6.49, undefined, { compact: true })).toBe("£6.49");
    expect(currencySymbol(undefined)).toBe("£");
  });
});

describe("timezoneForCountry", () => {
  it("gives a Gulf shop its own zone, not London", () => {
    // The whole point: a Dubai shop on Europe/London advertises its hours
    // four hours out and publishes wrong service times to every marketplace.
    expect(timezoneForCountry("AE")).toBe("Asia/Dubai");
    expect(timezoneForCountry("SA")).toBe("Asia/Riyadh");
    expect(timezoneForCountry("KW")).toBe("Asia/Kuwait");
  });

  it("keeps London for the UK and for anything unmapped", () => {
    expect(timezoneForCountry("GB")).toBe("Europe/London");
    expect(timezoneForCountry("ZZ")).toBe("Europe/London");
    expect(timezoneForCountry(null)).toBe("Europe/London");
  });
});

describe("tenderNotesFor", () => {
  it("gives a Dubai counter the notes it is actually handed", () => {
    // The smallest AED note in circulation is a 10, so a UK 5/10/20/50 ladder
    // leaves the shortcut buttons unusable and staff key every amount by hand.
    expect(tenderNotesFor("AED")).toEqual([10, 20, 50, 100]);
  });

  it("keeps the UK ladder for GBP and for anything unmapped", () => {
    expect(tenderNotesFor("GBP")).toEqual([5, 10, 20, 50]);
    expect(tenderNotesFor("ZZZ")).toEqual([5, 10, 20, 50]);
    expect(tenderNotesFor(null)).toEqual([5, 10, 20, 50]);
  });

  it("includes the fractional dinar notes, which are real currency", () => {
    // A half-dinar note exists; rounding it off the keypad would lose a note
    // the customer actually hands over.
    expect(tenderNotesFor("KWD")).toContain(0.5);
  });

  it("formats a half-dinar button with its third decimal", () => {
    // The button label goes through money(), so 0.5 KWD must read 0.500 —
    // the same trap as every other price in a three-decimal currency.
    expect(formatMoney(0.5, "KWD", { compact: true })).toBe("KWD 0.500");
  });
});
