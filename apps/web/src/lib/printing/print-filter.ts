// "What this printer prints" — per-printer category / product filters.
//
// A shop with a bar printer and a grill printer wants drinks on one and
// burgers on the other. Kept on printer.defaults.printFilter:
//
//   { categories: ["Drinks"], items: ["Ayran"], catchAll: false }
//
// A printer WITHOUT a filter is untouched: it gets the whole receipt exactly
// as before, prices and QR included. Only a printer the operator has limited
// gets a station ticket — its own lines, no prices, no totals, no QR.
//
// Matching is by NAME (case-insensitive). The server's catalog dedupes
// categories by name so one "Drinks" tick covers every brand's Drinks, and a
// cloned menu (fresh ids) keeps working. Order lines carry a menuItemId,
// resolved through the catalog; marketplace lines without one fall back to
// their printed name.
//
// Nothing is ever dropped silently. A line no printer claims goes to the
// "everything else" printers; if there are none and no unfiltered printer is
// printing either, it goes to every filtered printer — a duplicate ticket
// beats food that never gets made. Same rule if the catalog can't be loaded.

import { cleanPrintedItemName } from "@orderhub/shared";

export interface PrintFilter {
  /** Category names, as shown in the menu. */
  categories: string[];
  /** Product names, as shown in the menu. */
  items: string[];
  /** Also print every line no other filtered printer prints. */
  catchAll: boolean;
}

export interface FilterCatalogResponse {
  categories: Array<{ name: string; itemCount: number }>;
  items: Array<{ id: string; name: string; categories: string[] }>;
}

export interface FilterCatalog {
  byId: Map<string, { name: string; categories: string[] }>;
  /** normalised product name → union of its categories across menus */
  byName: Map<string, string[]>;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** The printer's filter, or null when it prints everything (the default). */
export function readPrintFilter(printer: any): PrintFilter | null {
  const f = printer?.defaults?.printFilter;
  if (!f || typeof f !== "object") return null;
  const categories = Array.isArray(f.categories)
    ? f.categories.map(String).filter((s: string) => s.trim())
    : [];
  const items = Array.isArray(f.items)
    ? f.items.map(String).filter((s: string) => s.trim())
    : [];
  const catchAll = f.catchAll === true;
  if (!categories.length && !items.length && !catchAll) return null;
  return { categories, items, catchAll };
}

export function buildFilterCatalog(
  res: FilterCatalogResponse | null | undefined,
): FilterCatalog | null {
  if (!res || !Array.isArray(res.items)) return null;
  const byId = new Map<string, { name: string; categories: string[] }>();
  const byName = new Map<string, string[]>();
  for (const it of res.items) {
    byId.set(it.id, { name: it.name, categories: it.categories ?? [] });
    const k = norm(it.name);
    const prev = byName.get(k) ?? [];
    byName.set(k, Array.from(new Set([...prev, ...(it.categories ?? [])])));
  }
  return { byId, byName };
}

/** Canonical product name + category names for one order line. */
function classify(
  line: any,
  catalog: FilterCatalog,
): { name: string; categories: string[] } {
  const known = line?.menuItemId ? catalog.byId.get(line.menuItemId) : undefined;
  if (known) return known;
  const name = cleanPrintedItemName(line?.name, line?.modifiers);
  return { name, categories: catalog.byName.get(norm(name)) ?? [] };
}

function claims(filter: PrintFilter, c: { name: string; categories: string[] }) {
  const cats = new Set(filter.categories.map(norm));
  const items = new Set(filter.items.map(norm));
  return items.has(norm(c.name)) || c.categories.some((x) => cats.has(norm(x)));
}

/**
 * Which order lines (by index into order.items) each FILTERED printer should
 * print. Printers missing from the result have no filter and print the whole
 * order, unchanged. An empty array means "nothing for this printer — skip it".
 *
 * `printers` must be the set that is actually about to print, so the
 * "everything else" and safety-net rules see the real picture.
 */
export function splitLinesForPrinters(
  lines: any[],
  printers: Array<{ id: string }>,
  catalog: FilterCatalog | null,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const filtered = printers
    .map((p) => ({ p, f: readPrintFilter(p) }))
    .filter((x): x is { p: { id: string }; f: PrintFilter } => !!x.f);
  if (!filtered.length) return out;

  const all = lines.map((_, i) => i);
  // No catalog: we cannot tell a drink from a burger. Print everything
  // everywhere rather than guess.
  if (!catalog) {
    for (const { p } of filtered) out.set(p.id, all);
    return out;
  }

  const hasUnfiltered = printers.length > filtered.length;
  const catchAlls = filtered.filter((x) => x.f.catchAll);
  const classes = lines.map((l) => classify(l, catalog));

  for (const { p } of filtered) out.set(p.id, []);
  classes.forEach((c, i) => {
    const owners = filtered.filter((x) => claims(x.f, c));
    if (owners.length) {
      for (const { p } of owners) out.get(p.id)!.push(i);
      return;
    }
    // Unclaimed: the catch-all printers take it; with none, and no
    // unfiltered printer printing the full order, every filtered printer
    // does — never lose a line.
    const fallback = catchAlls.length
      ? catchAlls
      : hasUnfiltered
        ? []
        : filtered;
    for (const { p } of fallback) {
      const arr = out.get(p.id)!;
      if (!arr.includes(i)) arr.push(i);
    }
  });
  for (const [id, arr] of out) out.set(id, arr.sort((a, b) => a - b));
  return out;
}

/**
 * The station-ticket version of a receipt payload: only the kept lines, no
 * prices, totals, payment band or QR (those belong to the whole order, and a
 * total on a drinks ticket would be wrong). Says how much of the order it is,
 * unless an event banner (cancelled / updated) is already there.
 */
export function stationPayload(payload: any, keep: number[]): any {
  const src: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const kept = keep.map((i) => src[i]).filter(Boolean);
  const partial = kept.length < src.length;
  return {
    ...payload,
    banner:
      payload?.banner ??
      (partial ? `PART ORDER - ${kept.length} OF ${src.length} ITEMS` : null),
    items: kept.map((it) => ({
      ...it,
      totalPrice: undefined,
      price: undefined,
      modifiers: Array.isArray(it?.modifiers)
        ? it.modifiers.map((m: any) => ({ ...m, price: undefined }))
        : [],
    })),
    subtotal: undefined,
    deliveryFee: undefined,
    tipAmount: undefined,
    serviceCharge: undefined,
    taxAmount: undefined,
    discount: undefined,
    total: undefined,
    totalAmount: undefined,
    paymentLabel: null,
    paymentMethod: null,
    paymentStatus: null,
    qrData: null,
    qrCaption: null,
    qrAlways: false,
  };
}

// The tablet resolves categories at print time. Cached per location for a
// few minutes; a failed fetch returns null, which prints everything.
const catalogCache = new Map<string, { at: number; value: FilterCatalog | null }>();
const TTL_MS = 5 * 60_000;

export async function loadFilterCatalog(
  locationId: string,
  fetcher: (locationId: string) => Promise<FilterCatalogResponse>,
): Promise<FilterCatalog | null> {
  const hit = catalogCache.get(locationId);
  if (hit && hit.value && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = buildFilterCatalog(await fetcher(locationId));
    catalogCache.set(locationId, { at: Date.now(), value });
    return value;
  } catch {
    // Keep serving a stale catalog over none at all.
    return hit?.value ?? null;
  }
}
