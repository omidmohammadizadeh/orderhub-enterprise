// Service charge — the "optional 10%" a sit-down restaurant adds to a bill.
//
// Configured per location at `Location.settings.serviceCharge`, alongside the
// delivery-fee and promo settings the POS already owns, so enabling it is a
// settings write and needs no deploy.
//
// Deliberately NOT folded into subtotal: it goes on the order as its own
// column so the receipt can itemise it, a refund can reason about it, and
// dine-in reporting can total it separately from food revenue. HMRC treats a
// discretionary service charge differently from the food it sits on, so
// merging the two would be the wrong shape even if it were less code.

export interface ServiceChargeConfig {
  enabled: boolean;
  /** Percent of the (discounted) food subtotal, e.g. 10 = 10%. */
  percent: number;
  /** Only add it to dine-in bills. On by default — nobody expects it on a
   *  takeaway. */
  dineInOnly: boolean;
  /** What the customer sees on the bill. */
  label: string;
}

export const DEFAULT_SERVICE_CHARGE: ServiceChargeConfig = {
  enabled: false,
  percent: 10,
  dineInOnly: true,
  label: "Service charge",
};

/** Read the config off a Location.settings blob, with safe fallbacks. */
export function readServiceCharge(settings: unknown): ServiceChargeConfig {
  const raw = ((settings ?? {}) as any)?.serviceCharge ?? {};
  const percent = Number(raw.percent);
  return {
    enabled: !!raw.enabled,
    // Clamp hard: a fat-fingered 1000 must not triple a customer's bill.
    percent:
      Number.isFinite(percent) && percent > 0 ? Math.min(percent, 25) : 0,
    dineInOnly: raw.dineInOnly !== false,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : DEFAULT_SERVICE_CHARGE.label,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * What to charge on a given bill. Applied to the subtotal AFTER discount —
 * charging service on money the customer didn't pay would be indefensible
 * if anyone ever checked.
 */
export function computeServiceCharge(args: {
  settings: unknown;
  fulfillmentType: string | null | undefined;
  subtotal: number;
  discount?: number;
}): { amount: number; config: ServiceChargeConfig } {
  const config = readServiceCharge(args.settings);
  if (!config.enabled || config.percent <= 0) return { amount: 0, config };
  if (config.dineInOnly && args.fulfillmentType !== "DINE_IN") {
    return { amount: 0, config };
  }
  const base = Math.max(
    0,
    Number(args.subtotal ?? 0) - Number(args.discount ?? 0),
  );
  return { amount: round2((base * config.percent) / 100), config };
}
