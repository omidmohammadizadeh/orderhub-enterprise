import { describe, expect, it } from "vitest";
import { hasHouseNumberOrName, isPlausibleCustomerPhone } from "@orderhub/shared";

describe("isPlausibleCustomerPhone (UK shop)", () => {
  it.each([
    "07788 187123",
    "07788187123",
    "+44 7788 187123",
    "+44 (0)7788 187123",
    "0044 7788 187123",
    "7788187123",
    "01388 436844",
    "0191 231 2345",
  ])("accepts %s", (n) => expect(isPlausibleCustomerPhone(n, "GB")).toBe(true));

  it.each([
    "",
    "123",
    "0778818712",
    "077881871234",
    "07777777777",
    "00000000000",
    "09012 345678",
    "call me",
  ])("refuses %s", (n) => expect(isPlausibleCustomerPhone(n, "GB")).toBe(false));

  it("takes a foreign number on a UK shop on length alone", () => {
    expect(isPlausibleCustomerPhone("+353 87 123 4567", "GB")).toBe(true);
  });
});

describe("isPlausibleCustomerPhone (elsewhere)", () => {
  it("checks length only", () => {
    expect(isPlausibleCustomerPhone("050 123 4567", "AE")).toBe(true);
    expect(isPlausibleCustomerPhone("087 123 4567", "IE")).toBe(true);
    expect(isPlausibleCustomerPhone("1234", "AE")).toBe(false);
  });
});

describe("hasHouseNumberOrName", () => {
  it("accepts a number or name in the house box", () => {
    expect(hasHouseNumberOrName({ line1: "Ash Terrace", line2: "12" })).toBe(true);
    expect(hasHouseNumberOrName({ line1: "Ash Terrace", line2: "Rose Cottage" })).toBe(true);
  });

  it("accepts a number carried on the street line", () => {
    expect(hasHouseNumberOrName({ line1: "35 Brunel Street" })).toBe(true);
    expect(hasHouseNumberOrName({ line1: "35a High St" })).toBe(true);
    expect(hasHouseNumberOrName({ line1: "55 Willow Road, Ferryhill" })).toBe(true);
    expect(hasHouseNumberOrName({ line1: "Flat 2, 10 Oak Road" })).toBe(true);
  });

  it("refuses a street on its own", () => {
    expect(hasHouseNumberOrName({ line1: "Ash Terrace" })).toBe(false);
    expect(hasHouseNumberOrName({ line1: "Maple Grove", line2: "  " })).toBe(false);
  });
});
