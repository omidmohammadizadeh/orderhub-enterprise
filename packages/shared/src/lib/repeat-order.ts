/**
 * Turning a customer's last order back into a basket.
 *
 * Pure, and in here rather than inside the till's React effect, because this
 * has now been got wrong twice in ways nobody could see from the code:
 *
 *   • the menu was indexed by the wrong id (a category holds LINKS, and the
 *     product is `link.item`), so every line was judged missing and the
 *     basket came out empty;
 *   • sized lines were dropped when their size could not be identified —
 *     which, since the size was never actually recorded on an order line, was
 *     every sized line there has ever been. Again: an empty basket.
 *
 * Both were shape mistakes, and both reached a real shop. The rules are now
 * testable on their own.
 */

export interface RepeatSourceItem {
  menuItemId?: string | null;
  name: string;
  quantity: number;
  unitPrice: number | string;
  notes?: string | null;
  modifiers?: Array<{ name: string; price?: number | string }> | null;
  /** The size sold, where it was recorded. */
  sku?: string | null;
  metadata?: { sku?: string | null } | null;
}

export interface RepeatMenuItem {
  id: string;
  name: string;
  basePrice: number | string;
  plu?: string | null;
  hasMultipleSkus?: boolean;
  productSkus?: Array<{ name?: string | null; plu?: string | null; price: number | string }>;
}

export interface RepeatLine {
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  plu: string | null;
  modifiers: Array<{ name: string; price: number }>;
  notes: string;
}

export interface RepeatResult {
  lines: RepeatLine[];
  /** No longer on the menu — the kitchen cannot make it. */
  gone: string[];
  /** Re-priced from today's menu. */
  repriced: string[];
  /** Sized, size unidentifiable, left at what the customer paid last time. */
  kept: string[];
}

/**
 * @param liveItems today's menu, keyed by MenuItem id.
 */
export function buildRepeatLines(
  items: RepeatSourceItem[],
  liveItems: Map<string, RepeatMenuItem>,
): RepeatResult {
  const out: RepeatResult = { lines: [], gone: [], repriced: [], kept: [] };

  for (const it of items ?? []) {
    const live = it.menuItemId ? liveItems.get(it.menuItemId) : null;
    // The only reason to drop a line: the shop cannot make it any more.
    if (!live) {
      out.gone.push(it.name);
      continue;
    }

    // A sized product is priced by its SIZE, not by the product's base price —
    // repeating a 12" at the 10" price undercharges every time.
    //
    // Three ways to find that size, in falling order of trust. Orders placed
    // before the size was recorded on the line have only the printed name to
    // go on — VEGETARIAN (10", stuffed crust) — so it is looked for in there.
    const sized = live.hasMultipleSkus === true;
    const skus = sized ? (live.productSkus ?? []) : [];
    const recorded = it.sku ?? it.metadata?.sku ?? null;
    const sku = sized
      ? (skus.find((v) => v.plu && v.plu === recorded) ??
        skus.find((v) => v.name && it.name?.includes(String(v.name))) ??
        null)
      : null;

    const was = Number(it.unitPrice);
    const wasUsable = Number.isFinite(was);
    // A sized line is re-priced only when we know WHICH size. Falling back to
    // the base price would undercharge; dropping the line hands the operator
    // an empty basket, which is worse than either.
    const now = sized
      ? Number(sku ? sku.price : was)
      : Number(live.basePrice);
    const price = Number.isFinite(now) ? now : was;

    if (sized && !sku) out.kept.push(it.name);
    else if (wasUsable && Math.abs(price - was) >= 0.01) out.repriced.push(it.name);

    out.lines.push({
      menuItemId: live.id,
      // The recorded name carries the size; the product's own name does not.
      displayName: it.name || live.name,
      unitPrice: Number.isFinite(price) ? price : 0,
      quantity: it.quantity,
      plu: sku?.plu ?? live.plu ?? null,
      // Modifier prices stay as recorded: nothing on the row ties them back to
      // a live option, so re-pricing them would be guesswork.
      modifiers: (it.modifiers ?? []).map((m) => ({
        name: m.name,
        price: Number(m.price ?? 0),
      })),
      notes: it.notes ?? "",
    });
  }

  return out;
}

/** The menu index, built the one way that works: a category holds LINKS. */
export function indexMenuItems(categories: unknown): Map<string, RepeatMenuItem> {
  const map = new Map<string, RepeatMenuItem>();
  for (const c of (categories as any[]) ?? []) {
    for (const link of c?.items ?? []) {
      // Tolerate both shapes. `link.item` is what the POS menu returns; a bare
      // item is what every other caller assumes it returns.
      const item = link?.item ?? link;
      if (item?.id) map.set(item.id, item);
    }
  }
  return map;
}
