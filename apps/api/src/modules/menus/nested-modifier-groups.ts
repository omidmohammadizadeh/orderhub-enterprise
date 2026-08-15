// ── Phase BN — resolving nested modifier groups for the pickers ─────────────
//
// A modifier option can open further groups when it's chosen:
//
//   Big Boss Burger → Make It a Meal → Fries → Garlic Mayo
//
// Those nested groups hang off an OPTION, not off the product, so they never
// appear in `item.modifierGroupLinks` and no include depth on the item query
// reaches them. They have to be fetched separately, by id.
//
// The payload shape is deliberately flat: every option gains an ordered
// `nestedGroupIds[]`, and the whole reachable set of groups is returned as one
// array the client indexes by id. A recursive include would need a fixed depth
// baked into every query; a flat map lets one lookup serve any depth.
//
// Scoping: groups are fetched BY ID filtered on the tenant, never by listing a
// brand's groups and matching. A brand-scoped list silently omits groups that
// live on another brand of the same tenant, which is exactly how the per-size
// SKU groups went missing on the storefront.

import type { PrismaService } from "../../infrastructure/database/prisma.service";

/**
 * How deep a picker will follow nesting. Deliveroo uses two levels
 * (meal → side → dip); three leaves room without letting a hand-built
 * catalog turn into an unbounded walk.
 */
export const MAX_NESTING_DEPTH = 3;

interface ResolvableGroup {
  id: string;
  name?: string;
  options?: Array<{
    id: string;
    nestedGroupIds?: string[];
    nestedGroups?: Array<{ id: string; name: string }>;
  }> | null;
}

/**
 * Annotates every option in `rootGroups` with the ids of the groups it opens,
 * and returns the flat set of those groups (recursively), each with its own
 * options annotated the same way.
 *
 * Mutates the options in `rootGroups` — callers pass the objects they're about
 * to serialise. Returns [] for a flat menu, which is every menu that has never
 * been imported from a platform that nests.
 */
export async function resolveNestedModifierGroups(
  prisma: PrismaService,
  rootGroups: ResolvableGroup[],
  opts: { tenantId: string; onlyAvailable?: boolean },
): Promise<any[]> {
  const optionIds = collectOptionIds(rootGroups);
  if (optionIds.length === 0) return [];

  const onlyAvailable = opts.onlyAvailable ?? false;
  const collected: any[] = [];
  // Guards a cycle: a hand-edited catalog can point a group at a descendant
  // of itself, and nothing in the schema forbids it. Visiting each group once
  // means the walk terminates whatever the data says.
  const seenGroupIds = new Set(rootGroups.map((g) => g.id));

  let frontierOptionIds = optionIds;
  let annotate: ResolvableGroup[] = rootGroups;
  // Names are filled in at the end, once every reachable group has been seen:
  // a nested group can be one we fetched OR one that was already in the list.
  const pendingNames: Array<{
    opt: { nestedGroups?: Array<{ id: string; name: string }> };
    ids: string[];
  }> = [];

  for (let depth = 0; depth < MAX_NESTING_DEPTH; depth++) {
    const links = await prisma.modifierOptionNestedGroup.findMany({
      where: { optionId: { in: frontierOptionIds } },
      orderBy: { sortOrder: "asc" },
      select: { optionId: true, groupId: true },
    });
    if (links.length === 0) break;

    // Write the ids onto the options we were given, in sortOrder — this is
    // what makes the picker ask for a side before it asks for a drink.
    const byOption = new Map<string, string[]>();
    for (const l of links) {
      const list = byOption.get(l.optionId) ?? [];
      list.push(l.groupId);
      byOption.set(l.optionId, list);
    }
    for (const g of annotate) {
      for (const opt of g.options ?? []) {
        const ids = byOption.get(opt.id);
        if (ids?.length) {
          opt.nestedGroupIds = ids;
          pendingNames.push({ opt, ids });
        }
      }
    }

    const wanted = Array.from(new Set(links.map((l) => l.groupId))).filter(
      (id) => !seenGroupIds.has(id),
    );
    if (wanted.length === 0) break;
    wanted.forEach((id) => seenGroupIds.add(id));

    const groups = await prisma.modifierGroup.findMany({
      where: {
        id: { in: wanted },
        // Tenant scope, not brand: a nested group can legitimately belong to
        // a sibling brand of the same tenant. Never unscoped — these ids come
        // off rows the request hasn't otherwise proved it may read.
        brand: { tenantId: opts.tenantId },
      },
      include: {
        options: {
          ...(onlyAvailable ? { where: { isAvailable: true } } : {}),
          orderBy: { sortOrder: "asc" as const },
        },
      },
    });
    if (groups.length === 0) break;

    collected.push(...groups);
    annotate = groups as unknown as ResolvableGroup[];
    frontierOptionIds = collectOptionIds(annotate);
    if (frontierOptionIds.length === 0) break;
  }

  // Attach the names. Callers render these directly rather than joining the
  // ids against a separately-fetched group list — that list is brand-scoped
  // in the dashboard, so a cross-brand nested group came out as "Unknown".
  const nameById = new Map<string, string>();
  for (const g of [...rootGroups, ...collected]) {
    if (g.name) nameById.set(g.id, g.name);
  }
  for (const { opt, ids } of pendingNames) {
    opt.nestedGroups = ids.map((id) => ({
      id,
      name: nameById.get(id) ?? "",
    }));
  }

  return collected;
}

function collectOptionIds(groups: ResolvableGroup[]): string[] {
  const ids = new Set<string>();
  for (const g of groups) {
    for (const opt of g.options ?? []) ids.add(opt.id);
  }
  return Array.from(ids);
}

/** Every group in an item payload, root and nested, for a fold/price pass. */
export function flattenGroupsForPricing(
  rootGroups: ResolvableGroup[],
  nested: ResolvableGroup[],
): ResolvableGroup[] {
  return [...rootGroups, ...nested];
}
