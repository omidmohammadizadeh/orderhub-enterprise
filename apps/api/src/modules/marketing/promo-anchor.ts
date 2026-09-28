// Map the MenuItem ids a campaign was built with onto the items a menu
// actually serves.
//
// Campaigns store the ids the operator picked; a republished or per-location
// menu (Phase BA) serves different rows for the same products, so a stored id
// can be missing from the menu the customer or cashier is looking at. Ids the
// menu already serves pass through; the rest are re-anchored by externalId,
// then by normalised name. `staleRows` is the caller's lookup of those rows.

export interface AnchorRow {
  id: string;
  name: string | null;
  externalId: string | null;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** The ids a menu serves plus its stable keys. */
export function indexServedMenu(menu: any) {
  const servedIds = new Set<string>();
  const byExternal = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const cat of menu?.categories ?? []) {
    for (const link of cat.items ?? []) {
      const it = link.item ?? {};
      const id: string | undefined = it.id ?? link.itemId;
      if (!id) continue;
      servedIds.add(id);
      if (it.externalId) byExternal.set(String(it.externalId), id);
      if (it.name && !byName.has(norm(it.name))) byName.set(norm(it.name), id);
    }
  }
  return { servedIds, byExternal, byName };
}

export function anchorIds(
  served: ReturnType<typeof indexServedMenu>,
  ids: string[],
  staleRows: AnchorRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of ids) if (served.servedIds.has(id)) map.set(id, id);
  for (const r of staleRows) {
    if (map.has(r.id)) continue;
    const hit =
      (r.externalId && served.byExternal.get(String(r.externalId))) || (r.name && served.byName.get(norm(r.name))) || null;
    if (hit) map.set(r.id, hit);
  }
  return map;
}
