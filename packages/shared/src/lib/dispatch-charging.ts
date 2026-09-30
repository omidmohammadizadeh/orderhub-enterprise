// Whether a location's courier dispatches are charged to its dispatch wallet.
//
// The default, and the only state a shop should ever trade in, is CHARGED: a
// dispatch that cannot take its fee does not happen. Stuart, Uber Direct and
// JET Go all bill the restaurant's own courier account for the courier itself;
// this fee is OrderHub's, and it is the one thing we have to collect before the
// job exists, because once a courier is moving the money is gone.
//
// The waiver is a testing switch. A platform admin ticks it on ONE shop so a
// sandbox dispatch can be driven end to end without funding a wallet first.
//
// It replaced an implicit rule that whether the fee was charged depended on
// whether the person clicking Dispatch happened to be a PLATFORM_ADMIN. That
// quietly meant every admin dispatch on a REAL shop was free, and nothing on
// screen said so. "This person is an admin" and "this shop is a test shop" are
// different facts, and only the second one should waive a fee.
//
// Lives on Location.settings, like dashboardAccess, and is stripped from
// ordinary location PATCH bodies so a tenant cannot switch off its own billing.

export const DISPATCH_CHARGING_SETTINGS_KEY = "dispatchCharging";

export interface DispatchChargingSettings {
  /** true → dispatch runs without touching the wallet. Testing only. */
  waiveWalletCharge: boolean;
  /** Why it is on, so the next person to look knows. */
  note?: string | null;
  /** When it was last switched, ISO. */
  updatedAt?: string | null;
}

function blob(settings: unknown): Record<string, unknown> | undefined {
  const s = settings as Record<string, unknown> | null | undefined;
  const b = s?.[DISPATCH_CHARGING_SETTINGS_KEY];
  return b && typeof b === "object" ? (b as Record<string, unknown>) : undefined;
}

/**
 * Is the wallet charge waived for this location?
 *
 * Strictly `=== true`. Anything else — missing, null, "false", 0, a truthy
 * string — bills, because the safe default when the setting is unreadable is
 * to charge rather than to give away dispatches.
 */
export function dispatchChargeWaivedFromSettings(settings: unknown): boolean {
  return blob(settings)?.waiveWalletCharge === true;
}

export function dispatchChargingFromSettings(
  settings: unknown,
): DispatchChargingSettings {
  const b = blob(settings);
  return {
    waiveWalletCharge: b?.waiveWalletCharge === true,
    note: typeof b?.note === "string" && b.note.trim() ? b.note.trim() : null,
    updatedAt: typeof b?.updatedAt === "string" ? b.updatedAt : null,
  };
}
