// Phase AY (P2) — the in-progress WhatsApp cart. Stored as JSON on
// WhatsAppConversation.cart and mutated by the AI engine's tools. Prices are
// plain numbers, in the SHOP's currency, computed from the live menu at
// add-time so the running total never drifts from what the customer was
// quoted. The currency itself is not stored on the cart — it comes from the
// location every time something is rendered, so a cart can't outlive a
// currency change holding stale symbols.

import { formatMoney } from "@orderhub/shared";

/** Money for a WhatsApp message.
 *
 *  Compact (symbol + amount, no locale grouping) because these are chat
 *  messages, not receipts — and because formatMoney's compact path still asks
 *  currencyDecimals, so a Kuwaiti dinar prints its three decimals rather than
 *  being silently rounded to two. Every price the bot says goes through here;
 *  it used to be a hardcoded `£${n.toFixed(2)}` in twenty-odd places. */
export function money(n: number, currency = "GBP"): string {
  return formatMoney(n, currency, { compact: true });
}

export type WaFulfillmentType = "DELIVERY" | "PICKUP";

export interface WaCartModifier {
  optionId: string;
  name: string;
  /** Per-unit price adjustment for this modifier option. */
  price: number;
}

export interface WaCartLine {
  /** Stable id for this line so tools can target it (remove / update). */
  lineId: string;
  itemId: string;
  name: string;
  quantity: number;
  /** Base price of the item (before modifiers), per unit. */
  unitBasePrice: number;
  modifiers: WaCartModifier[];
  notes?: string;
}

export interface WaDeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  /** Optional — the Gulf has no postal code in everyday use. */
  postcode?: string;
  /** The named community the shop prices on, e.g. "Dubai Marina". */
  area?: string;
  country?: string;
}

// In-progress, code-driven modifier selection for one item (wrap → sauce →
// drink …). Asked one group at a time, deterministically — no AI, no loops.
export interface WaPending {
  itemId: string;
  /** Group ids to ask, in order. */
  groupIds: string[];
  /** groupId -> chosen optionIds (single-select = 0/1; multi-select = 0+). */
  chosen: Record<string, string[]>;
  /** Group ids the customer has finished (in completion order — used by Back). */
  done: string[];
}

export interface WaCart {
  fulfillmentType: WaFulfillmentType;
  deliveryAddress?: WaDeliveryAddress;
  items: WaCartLine[];
  /** Set while a customer is picking an item's options group-by-group. */
  pending?: WaPending;
  /** True once collection/delivery (+ address) has been completed up front. */
  fulfillmentChosen?: boolean;
}

export function emptyCart(): WaCart {
  return { fulfillmentType: "DELIVERY", items: [] };
}

/** Coerce a persisted `chosen` map into Record<groupId, optionId[]>. */
function normaliseChosen(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.filter(Boolean).map(String);
    else if (typeof v === "string") out[k] = v ? [v] : []; // legacy single-value
  }
  return out;
}

/** Coerce whatever was persisted in the Json column back into a WaCart. */
export function coerceCart(raw: unknown): WaCart {
  if (!raw || typeof raw !== "object") return emptyCart();
  const c = raw as Partial<WaCart>;
  return {
    fulfillmentType: c.fulfillmentType === "PICKUP" ? "PICKUP" : "DELIVERY",
    deliveryAddress: c.deliveryAddress,
    fulfillmentChosen: c.fulfillmentChosen === true,
    pending:
      c.pending && typeof c.pending === "object" && Array.isArray((c.pending as any).groupIds)
        ? {
            itemId: String((c.pending as any).itemId ?? ""),
            groupIds: (c.pending as any).groupIds.map(String),
            chosen: normaliseChosen((c.pending as any).chosen),
            done: Array.isArray((c.pending as any).done)
              ? (c.pending as any).done.map(String)
              : [],
          }
        : undefined,
    items: Array.isArray(c.items)
      ? c.items.map((i) => ({
          lineId: String(i.lineId ?? ""),
          itemId: String(i.itemId ?? ""),
          name: String(i.name ?? ""),
          quantity: Math.max(1, Math.round(Number(i.quantity) || 1)),
          unitBasePrice: Number(i.unitBasePrice) || 0,
          modifiers: Array.isArray(i.modifiers)
            ? i.modifiers.map((m) => ({
                optionId: String(m.optionId ?? ""),
                name: String(m.name ?? ""),
                price: Number(m.price) || 0,
              }))
            : [],
          notes: i.notes ? String(i.notes) : undefined,
        }))
      : [],
  };
}

/** Per-unit price of a line: base + sum of modifier adjustments. */
export function lineUnitPrice(line: WaCartLine): number {
  const mods = line.modifiers.reduce((s, m) => s + (m.price || 0), 0);
  return round2(line.unitBasePrice + mods);
}

export function lineTotal(line: WaCartLine): number {
  return round2(lineUnitPrice(line) * line.quantity);
}

export function cartSubtotal(cart: WaCart): number {
  return round2(cart.items.reduce((s, l) => s + lineTotal(l), 0));
}

export function cartItemCount(cart: WaCart): number {
  return cart.items.reduce((s, l) => s + l.quantity, 0);
}

/** Human-readable cart summary for the AI to read (and to mirror to the user).
 *
 *  `currency` defaults to GBP only so a caller that genuinely has no context
 *  still renders something — every real caller passes the shop's own currency.
 *  This printed a hardcoded £ before, so a Dubai customer was quoted their
 *  order in pounds. */
export function summarizeCart(cart: WaCart, currency = "GBP"): string {
  if (cart.items.length === 0) return "(empty)";
  const lines = cart.items.map((l) => {
    const mods =
      l.modifiers.length > 0
        ? ` [${l.modifiers.map((m) => m.name).join(", ")}]`
        : "";
    const note = l.notes ? ` (note: ${l.notes})` : "";
    return `${l.quantity}× ${l.name}${mods}${note} — ${money(lineTotal(l), currency)}`;
  });
  lines.push(`Subtotal: ${money(cartSubtotal(cart), currency)}`);
  lines.push(`Fulfillment: ${cart.fulfillmentType}`);
  if (cart.deliveryAddress) {
    const a = cart.deliveryAddress;
    lines.push(
      // `area` sits before city: in the Gulf it is the locating part of the
      // address and there is no postcode behind it.
      `Address: ${[a.line1, a.line2, a.area, a.city, a.postcode].filter(Boolean).join(", ")}`,
    );
  }
  return lines.join("\n");
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
