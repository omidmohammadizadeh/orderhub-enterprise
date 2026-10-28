import { ForbiddenException } from "@nestjs/common";

// Where a shop's card money lands and how much OrderHub keeps of it. Only
// OrderHub (PLATFORM_ADMIN) sets these. The dashboard hides them from shops,
// but hiding a field is not a permission: the same PATCH is one request away
// for any owner, who could zero the fee or point payouts at another account.

export const BRAND_MONEY_FIELDS = [
  "stripeConnectedAccountId",
  "tapDestinationId",
  "applicationFeeMode",
  "applicationFeeFixedAmount",
  "applicationFeePercentage",
] as const;

export const LOCATION_MONEY_FIELDS = [
  "stripeConnectedAccountId",
  "applicationFeeMode",
  "applicationFeeFixedAmount",
  "applicationFeePercentage",
  "posStripeAccountId",
  "posApplicationFeePercent",
  "posApplicationFeeFixedMinor",
  "posTerminalApplicationFeePercent",
  "posTerminalApplicationFeeFixedMinor",
] as const;

export const MONEY_FIELD_ROLE = "PLATFORM_ADMIN";

/** Blank and null are the same setting; numbers compare by value, so a stored
 *  Decimal "5.00" equals a sent 5. */
function sameSetting(sent: unknown, stored: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
  if (blank(sent) || blank(stored)) return blank(sent) && blank(stored);
  const a = Number(sent);
  const b = Number(String(stored));
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return String(sent).trim() === String(stored).trim();
}

/**
 * Refuses a non-admin CHANGE to any money field. A field sent back with the
 * value already stored is removed from the dto instead of refused: forms
 * round-trip every field on save, and an owner's unrelated edit must still go
 * through.
 */
export function guardMoneyFields(
  dto: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  fields: readonly string[],
  role: string | undefined,
): void {
  if (role === MONEY_FIELD_ROLE) return;
  const changed: string[] = [];
  for (const field of fields) {
    if (dto[field] === undefined) continue;
    if (stored && sameSetting(dto[field], stored[field])) {
      delete dto[field];
    } else {
      changed.push(field);
    }
  }
  if (changed.length) {
    throw new ForbiddenException(
      `Only OrderHub can change payout accounts and fees (${changed.join(", ")}). Contact OrderHub support.`,
    );
  }
}
