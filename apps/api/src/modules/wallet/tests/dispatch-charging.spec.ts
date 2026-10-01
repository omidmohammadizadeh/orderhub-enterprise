import {
  dispatchChargeWaivedFromSettings,
  dispatchChargingFromSettings,
  DISPATCH_CHARGING_SETTINGS_KEY,
} from "@orderhub/shared";
import { stripAdminOnlySettings } from "../../locations/locations.service";

// Whether a courier dispatch takes OrderHub's fee out of the wallet.
//
// The rule that matters: a dispatch that cannot take its fee must not happen.
// The only way past it is a per-location testing waiver an admin ticks — NOT
// the caller's role, which is what it used to be and which quietly made every
// admin dispatch on a real shop free.

const withSetting = (v: unknown) => ({ [DISPATCH_CHARGING_SETTINGS_KEY]: v });

describe("reading the waiver", () => {
  it("charges when the setting is absent", () => {
    expect(dispatchChargeWaivedFromSettings(null)).toBe(false);
    expect(dispatchChargeWaivedFromSettings({})).toBe(false);
    expect(dispatchChargeWaivedFromSettings(undefined)).toBe(false);
  });

  it("waives only on a literal true", () => {
    expect(dispatchChargeWaivedFromSettings(withSetting({ waiveWalletCharge: true }))).toBe(true);
    expect(dispatchChargeWaivedFromSettings(withSetting({ waiveWalletCharge: false }))).toBe(false);
  });

  it.each([["true"], [1], ["yes"], [{}], [[]]])(
    "does not accept %p as a waiver",
    (v) => {
      // A truthy-but-not-true value billing nothing would be a silent giveaway,
      // so anything that isn't exactly true charges.
      expect(dispatchChargeWaivedFromSettings(withSetting({ waiveWalletCharge: v }))).toBe(false);
    },
  );

  it("survives a settings blob of the wrong shape", () => {
    expect(dispatchChargeWaivedFromSettings(withSetting("nonsense"))).toBe(false);
    expect(dispatchChargeWaivedFromSettings("nonsense")).toBe(false);
    expect(dispatchChargeWaivedFromSettings(42)).toBe(false);
  });

  it("reads the note and timestamp back for the admin screen", () => {
    const s = dispatchChargingFromSettings(
      withSetting({
        waiveWalletCharge: true,
        note: "  JET Go sandbox  ",
        updatedAt: "2026-09-30T10:00:00.000Z",
      }),
    );
    expect(s).toEqual({
      waiveWalletCharge: true,
      note: "JET Go sandbox",
      updatedAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("treats a blank note as no note", () => {
    expect(dispatchChargingFromSettings(withSetting({ note: "   " })).note).toBeNull();
  });
});

describe("only an admin can set it", () => {
  it("strips the key from a tenant's own location PATCH", () => {
    // Otherwise an owner turns off their own dispatch billing with one call.
    const dto = {
      settings: { [DISPATCH_CHARGING_SETTINGS_KEY]: { waiveWalletCharge: true }, other: 1 },
    };
    expect(stripAdminOnlySettings(dto, "OWNER").settings).toEqual({ other: 1 });
    expect(stripAdminOnlySettings(dto, "TENANT_OWNER").settings).toEqual({ other: 1 });
    expect(stripAdminOnlySettings(dto, undefined).settings).toEqual({ other: 1 });
  });

  it("lets a platform admin through", () => {
    const dto = {
      settings: { [DISPATCH_CHARGING_SETTINGS_KEY]: { waiveWalletCharge: true } },
    };
    expect(stripAdminOnlySettings(dto, "PLATFORM_ADMIN")).toBe(dto);
  });

  it("still strips dashboardAccess alongside it", () => {
    const dto = {
      settings: {
        dashboardAccess: { disabledTabs: ["orders"] },
        [DISPATCH_CHARGING_SETTINGS_KEY]: { waiveWalletCharge: true },
        keep: true,
      },
    };
    expect(stripAdminOnlySettings(dto, "OWNER").settings).toEqual({ keep: true });
  });

  it("leaves an unrelated body untouched without copying it", () => {
    const dto = { settings: { other: 1 } };
    expect(stripAdminOnlySettings(dto, "OWNER")).toBe(dto);
  });
});
