// Turning "Skin fade + beard trim with Jay" into priced, timed lines.
//
// Pure, so the rules (who does what, at what price, with which extras) are
// tested without a database.

import { linePrice, round2, type SalonLine } from "@orderhub/shared";

export interface ServiceRow {
  id: string;
  name: string;
  price: number | { toString(): string };
  priceFrom?: boolean;
  durationMins: number;
  bufferMins: number;
  processingStartMins: number | null;
  processingMins: number | null;
  depositType: string;
  depositValue: number | { toString(): string } | null;
  bookableOnline: boolean;
  isActive: boolean;
  requiresPatchTest?: boolean;
  addons: unknown;
}

export interface StaffRow {
  id: string;
  name: string;
  serviceIds: string[];
  priceOverrides: unknown;
  bookableOnline: boolean;
  isActive: boolean;
  acceptsWalkIns?: boolean;
}

export interface WantedService {
  serviceId: string;
  addonIds?: string[];
}

export interface StoredLine extends SalonLine {
  priceFrom?: boolean;
  requiresPatchTest?: boolean;
}

/** Does this person do every one of these services? */
export function staffDoes(staff: Pick<StaffRow, "serviceIds">, serviceIds: string[]): boolean {
  if (!staff.serviceIds || staff.serviceIds.length === 0) return true;
  return serviceIds.every((id) => staff.serviceIds.includes(id));
}

/**
 * Build the lines for a booking. Throws a guest-readable message on anything
 * that can't be booked (unknown, switched off, not bookable online).
 */
export function buildLines(opts: {
  wanted: WantedService[];
  services: ServiceRow[];
  staff?: StaffRow | null;
  online: boolean;
}): StoredLine[] {
  if (!Array.isArray(opts.wanted) || opts.wanted.length === 0) {
    throw new Error("Pick at least one service");
  }
  if (opts.wanted.length > 8) throw new Error("That's a lot of services for one visit — call the shop");
  const byId = new Map(opts.services.map((s) => [s.id, s]));
  const overrides = (opts.staff?.priceOverrides ?? {}) as Record<string, number>;
  return opts.wanted.map((w) => {
    const s = byId.get(String(w?.serviceId));
    if (!s || !s.isActive) throw new Error("One of those services isn't available any more");
    if (opts.online && !s.bookableOnline) {
      throw new Error(`${s.name} can't be booked online — please call the shop`);
    }
    const addons = (Array.isArray(s.addons) ? s.addons : []) as Array<{
      id: string;
      name: string;
      price: number;
      durationMins: number;
    }>;
    const chosen = Array.from(new Set((w.addonIds ?? []).map(String)))
      .map((id) => addons.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => ({
        id: a.id,
        name: a.name,
        price: round2(Number(a.price) || 0),
        durationMins: Math.max(0, Math.round(Number(a.durationMins) || 0)),
      }));
    const override = overrides[s.id];
    const price = override !== undefined && Number.isFinite(Number(override)) ? Number(override) : Number(s.price);
    return {
      serviceId: s.id,
      name: s.name,
      price: round2(price),
      durationMins: s.durationMins,
      bufferMins: s.bufferMins,
      processingStartMins: s.processingStartMins,
      processingMins: s.processingMins,
      depositType: s.depositType,
      depositValue: s.depositValue == null ? null : Number(s.depositValue),
      addons: chosen,
      priceFrom: !!s.priceFrom,
      requiresPatchTest: !!s.requiresPatchTest,
    };
  });
}

/** Lines read back off an appointment row. */
export function storedLines(raw: unknown): StoredLine[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => ({
    serviceId: String(l?.serviceId ?? ""),
    name: String(l?.name ?? "Service"),
    price: Number(l?.price) || 0,
    durationMins: Number(l?.durationMins) || 0,
    bufferMins: Number(l?.bufferMins) || 0,
    processingStartMins: l?.processingStartMins ?? null,
    processingMins: l?.processingMins ?? null,
    depositType: l?.depositType ?? "NONE",
    depositValue: l?.depositValue ?? null,
    addons: Array.isArray(l?.addons) ? l.addons : [],
    priceFrom: !!l?.priceFrom,
    requiresPatchTest: !!l?.requiresPatchTest,
  }));
}

/** "Skin fade + Beard trim" */
export function summariseLines(lines: Array<{ name: string; addons?: Array<{ name: string }> }>): string {
  return lines
    .map((l) => (l.addons?.length ? `${l.name} (+ ${l.addons.map((a) => a.name).join(", ")})` : l.name))
    .join(" + ");
}

export interface CheckoutLine {
  name: string;
  unitPrice: number;
  quantity: number;
  notes?: string;
}

/**
 * Take a credit (a deposit already paid, a manual discount) off the lines
 * themselves, first line first.
 *
 * Why not Order.discount: the Stripe payment-link page itemises the lines
 * and never subtracts the order's discount, so a discounted salon bill sent
 * as a link would charge the full price. Folding the credit into the lines
 * keeps every payment path — cash, card machine, link — charging the same.
 * Each line that gave something up says so in its notes.
 */
export function applyCredit(
  lines: CheckoutLine[],
  credit: number,
  label: string,
): { lines: CheckoutLine[]; applied: number } {
  let left = round2(Math.max(0, credit));
  const out = lines.map((l) => ({ ...l }));
  let applied = 0;
  for (const l of out) {
    if (left <= 0) break;
    const lineTotal = round2(l.unitPrice * l.quantity);
    const take = Math.min(lineTotal, left);
    if (take <= 0) continue;
    // A part-credited multi-quantity line becomes one line at the new total,
    // so the unit price never needs a fraction of a penny.
    if (l.quantity > 1 && take < lineTotal) {
      l.unitPrice = round2(lineTotal - take);
      l.name = `${l.name} ×${l.quantity}`;
      l.quantity = 1;
    } else {
      l.unitPrice = round2((lineTotal - take) / l.quantity);
    }
    left = round2(left - take);
    applied = round2(applied + take);
    l.notes = [l.notes, label].filter(Boolean).join(" · ");
  }
  return { lines: out, applied };
}

export function checkoutTotal(lines: CheckoutLine[]): number {
  return round2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
}

/** One order line per service and one per add-on, so the receipt reads true. */
export function linesForCheckout(lines: StoredLine[], staffName: string | null): CheckoutLine[] {
  const out: CheckoutLine[] = [];
  for (const l of lines) {
    out.push({ name: l.name, unitPrice: round2(l.price), quantity: 1, ...(staffName ? { notes: `with ${staffName}` } : {}) });
    for (const a of l.addons ?? []) {
      out.push({ name: `+ ${a.name}`, unitPrice: round2(Number(a.price) || 0), quantity: 1 });
    }
  }
  return out;
}

export { linePrice };
