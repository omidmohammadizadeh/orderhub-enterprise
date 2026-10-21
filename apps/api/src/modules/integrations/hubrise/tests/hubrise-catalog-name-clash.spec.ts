// A catalog name already used elsewhere in the HubRise account must not
// block the publish.
//
// HubRise wants catalog names unique per account and we name a catalog after
// its menu. On 2026-10-12 Fiesta Mexica's publish failed with
// `HubRise PUT /catalogs/7g3m4 → 422 … "/name" … "is not unique"` because
// another catalog already carried that menu's name.

import {
  catalogNameFallbacks,
  isCatalogNameTaken,
} from "../hubrise-catalog.service";

describe("HubRise catalog name clash", () => {
  const live = new Error(
    'HubRise PUT /catalogs/7g3m4 → 422: {"message":"Validation failed","errors":[{"field":"/name","message":"is not unique"}],"error_type":"unprocessable_entity"}',
  );

  it("recognises the exact error HubRise returned", () => {
    expect(isCatalogNameTaken(live)).toBe(true);
  });

  it("does not treat other validation errors as a name clash", () => {
    expect(
      isCatalogNameTaken(
        new Error(
          'HubRise PUT /catalogs/7g3m4 → 422: {"errors":[{"field":"/data/products/0/ref","message":"is not unique"}]}',
        ),
      ),
    ).toBe(false);
    expect(isCatalogNameTaken(new Error("HubRise PUT /catalogs/x → 401: unauthorized"))).toBe(false);
  });

  it("tries the shop name first, then a short location id", () => {
    expect(catalogNameFallbacks("Fiesta Mexica", "Bristol", "cmroxo5r7000dzt8o8ptm4476")).toEqual([
      "Fiesta Mexica – Bristol",
      "Fiesta Mexica – tm4476",
    ]);
  });

  it("skips the shop name when the menu name already contains it", () => {
    expect(catalogNameFallbacks("Fiesta Mexica Bristol", "bristol", "loc123456")).toEqual([
      "Fiesta Mexica Bristol – 123456",
    ]);
  });

  it("still has a fallback when the location has no name", () => {
    expect(catalogNameFallbacks("Menu", null, "abcdef")).toEqual(["Menu – abcdef"]);
  });
});
