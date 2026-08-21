import { toE164, sanitiseSenderId } from "../phone";

describe("toE164", () => {
  const prev = process.env.SMS_DEFAULT_COUNTRY_CODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.SMS_DEFAULT_COUNTRY_CODE;
    else process.env.SMS_DEFAULT_COUNTRY_CODE = prev;
  });

  it("converts the UK national format the POS actually receives", () => {
    // The exact shape that failed in production with
    // "Invalid 'To' Phone Number: 0778818XXXX".
    expect(toE164("07788187123")).toBe("+447788187123");
  });

  it("ignores spaces, dashes and brackets an operator types", () => {
    expect(toE164("07788 187 123")).toBe("+447788187123");
    expect(toE164("(07788) 187-123")).toBe("+447788187123");
  });

  it("keeps an already-international number untouched", () => {
    expect(toE164("+447788187123")).toBe("+447788187123");
    expect(toE164("+971 50 123 4567")).toBe("+971501234567");
  });

  it("handles the 00 international access prefix", () => {
    expect(toE164("00447788187123")).toBe("+447788187123");
  });

  it("adds the country code to a bare national number", () => {
    expect(toE164("7788187123")).toBe("+447788187123");
  });

  it("leaves a country code that is already present alone", () => {
    expect(toE164("447788187123")).toBe("+447788187123");
  });

  it("follows SMS_DEFAULT_COUNTRY_CODE for other markets", () => {
    process.env.SMS_DEFAULT_COUNTRY_CODE = "971";
    expect(toE164("0501234567")).toBe("+971501234567");
  });

  it("returns null for input that is not a phone number", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("123")).toBeNull();
    expect(toE164("n/a")).toBeNull();
    expect(toE164("0123456789012345678")).toBeNull();
  });
});

describe("sanitiseSenderId", () => {
  it("passes a normal shop name through", () => {
    expect(sanitiseSenderId("PizzaUno")).toBe("PizzaUno");
    expect(sanitiseSenderId("  Jintys  ")).toBe("Jintys");
  });

  it("truncates to the 11-character carrier limit", () => {
    // Would otherwise be rejected by the carrier as an invalid sender.
    expect(sanitiseSenderId("Pizza Uno Manchester")).toBe("Pizza Uno M");
  });

  it("strips punctuation the carrier will not accept", () => {
    expect(sanitiseSenderId("Jinty's Pizza")).toBe("Jinty s Piz");
    expect(sanitiseSenderId("Café Roma")).toBe("Cafe Roma");
  });

  it("rejects a name with no letters, so we fall back to the number", () => {
    expect(sanitiseSenderId("0161 123 4567")).toBeNull();
    expect(sanitiseSenderId("!!!")).toBeNull();
    expect(sanitiseSenderId("")).toBeNull();
    expect(sanitiseSenderId(null)).toBeNull();
  });
});
