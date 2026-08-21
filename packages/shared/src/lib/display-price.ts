// What price to show on a product card.
//
// A sized product (10"/12"/14" pizza) carries its prices on productSkus[];
// its own basePrice is left at 0 because there is no single price to put
// there. Every card rendered that basePrice directly, so half a pizza menu
// advertised "£0.00" until the customer opened the item and picked a size.
//
// When a base price IS set it is the headline: the default size, with every
// other size priced as a supplement on top of it. When there is none, the
// cheapest size is the only honest answer.
//
// Display only: the line still charges the size the customer actually picks.

export interface DisplayPrice {
  /** Amount to render. */
  amount: number;
  /** True when it's the cheapest of several sizes, so prefix it with "From". */
  from: boolean;
}

interface PricedItem {
  basePrice?: number | string | null;
  hasMultipleSkus?: boolean | null;
  productSkus?: unknown;
}

export function displayPrice(item: PricedItem | null | undefined): DisplayPrice {
  const base = Number(item?.basePrice ?? 0) || 0;
  const skus = Array.isArray(item?.productSkus) ? item.productSkus : [];

  // Ignore zero and non-numeric sizes: a half-configured size shouldn't drag
  // the advertised price down to nothing, which is the bug being fixed.
  const prices = skus
    .map((s: any) => Number(s?.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (prices.length === 0) return { amount: base, from: false };

  const cheapest = Math.min(...prices);
  // A base price above zero is the product's headline price — the default
  // size, which every other size is priced as a supplement on top of (see the
  // "+£" boxes in the product form). So show it, rather than the cheapest
  // size: quoting "From £3.99" for a £6.49 chicken because a meal upgrade was
  // mistyped advertised the wrong item entirely.
  //
  // "From" only when a size genuinely costs MORE, which is what the prefix
  // promises — a floor, not a midpoint.
  if (base > 0) {
    return { amount: base, from: prices.some((n) => n > base) };
  }
  // No base price at all — a sized product (10"/12"/14") carries its prices
  // only on the sizes, so the cheapest is the sole honest answer. This is the
  // case that stopped half a pizza menu advertising "£0.00".
  return { amount: cheapest, from: prices.length > 1 };
}

/** "£8.50" or "From £8.50". */
export function formatDisplayPrice(
  item: PricedItem | null | undefined,
  currency = "£",
): string {
  const { amount, from } = displayPrice(item);
  return `${from ? "From " : ""}${currency}${amount.toFixed(2)}`;
}
