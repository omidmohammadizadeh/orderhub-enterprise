import { cleanCustomerApp, customerAppLinks, readCustomerApp } from "../restaurant-apps";

describe("restaurant app store links", () => {
  it("promotes nothing until switched on", () => {
    expect(customerAppLinks({ customerApp: { promote: false, androidPackage: "com.orderhubsolutions.pizzauno" } })).toBeNull();
    expect(customerAppLinks({})).toBeNull();
    expect(customerAppLinks(null)).toBeNull();
  });

  it("builds both store links", () => {
    expect(
      customerAppLinks({
        customerApp: { promote: true, androidPackage: "com.orderhubsolutions.pizzauno", iosAppStoreId: "6824555180" },
      }),
    ).toEqual({
      android: "https://play.google.com/store/apps/details?id=com.orderhubsolutions.pizzauno",
      ios: "https://apps.apple.com/app/id6824555180",
      iosAppStoreId: "6824555180",
    });
  });

  it("drops stored values that aren't a package or an App Store id", () => {
    expect(readCustomerApp({ customerApp: { promote: true, androidPackage: "bad pkg", iosAppStoreId: "abc" } })).toEqual({
      promote: true,
      androidPackage: null,
      iosAppStoreId: null,
    });
  });

  it("validates admin input, accepting 'id123…' as pasted from the store", () => {
    expect(cleanCustomerApp({ promote: true, iosAppStoreId: "id6824555180" }).iosAppStoreId).toBe("6824555180");
    expect(() => cleanCustomerApp({ promote: true })).toThrow(/at least one store link/);
    expect(() => cleanCustomerApp({ androidPackage: "Pizza Uno" })).toThrow(/Android package/);
  });
});

describe("iOS onboarding details", () => {
  const { cleanIosOnboarding, readIosOnboarding } = jest.requireActual("../restaurant-apps");

  it("normalises the ids a client pastes", () => {
    const r = cleanIosOnboarding({
      teamId: " anr7vrqryt ",
      keyId: "2z46mc96fa",
      issuerId: "57246542-96FE-1A63-E053-0824D011072A",
      steps: { enrolled: true, bogus: true },
    });
    expect(r.teamId).toBe("ANR7VRQRYT");
    expect(r.keyId).toBe("2Z46MC96FA");
    expect(r.issuerId).toBe("57246542-96fe-1a63-e053-0824d011072a");
    expect(r.steps).toEqual({ enrolled: true, keyReceived: false, appRecordCreated: false, built: false, submitted: false, live: false });
  });

  it("refuses ids in the wrong shape with a hint", () => {
    expect(() => cleanIosOnboarding({ teamId: "ABC" })).toThrow(/Team ID/);
    expect(() => cleanIosOnboarding({ issuerId: "nope" })).toThrow(/Issuer ID/);
  });

  it("reads an empty brand as nothing done yet", () => {
    expect(readIosOnboarding(null).steps.live).toBe(false);
  });
});
