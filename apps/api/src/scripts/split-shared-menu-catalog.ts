/**
 * Split shared menu catalog into independent per-location copies.
 *
 * Historically `clone()` shared modifier groups with the source location and
 * `createMasterMenu()` shared whole menu items. Editing a cloned / master menu
 * therefore mutated the location it was built from. Going forward both flows
 * deep-copy (see menus.service `deepCopyItemTx`), but menus created BEFORE that
 * fix still share rows. This one-off migration forks those shared rows so every
 * menu owns its products / modifier groups / modifier options privately.
 *
 * What it does, per menu M at location L:
 *   - Any MenuItem linked into M that is also linked into a menu at a DIFFERENT
 *     location is deep-copied into a fresh product (new PLU, new modifier groups
 *     + options), and M's category links are re-pointed at the copy.
 *   - For items M keeps, any ModifierGroup that is shared across locations is
 *     copied and M's item→group link is re-pointed at the copy.
 *
 * "Home" location (the one that keeps the original row) = the location of the
 * lowest menu id sharing the row; every OTHER location gets a private copy.
 * Copies are shared within a single location (intra-location sharing preserved),
 * never across locations. Idempotent: re-running after a successful apply finds
 * nothing to fork.
 *
 * Dry-run (default — prints the plan, writes nothing):
 *   DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/split-shared-menu-catalog.ts
 *
 * Apply (writes the copies):
 *   APPLY=true DATABASE_URL=<url> \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/split-shared-menu-catalog.ts
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === "true";

// ── PLU generation (mirrors apps/api/src/modules/menus/plu.service.ts) ────────
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREFIX = {
  product: "PROD-",
  sku: "SKU-",
  modifierGroup: "MG-",
  modifier: "MOD-",
} as const;
type PluKind = keyof typeof PREFIX;

const usedPlus = new Set<string>();
function freshPlu(kind: PluKind): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++)
      suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const plu = PREFIX[kind] + suffix;
    if (!usedPlus.has(plu)) {
      usedPlus.add(plu);
      return plu;
    }
  }
  const plu = `${PREFIX[kind]}${usedPlus.size.toString(36).toUpperCase()}`;
  usedPlus.add(plu);
  return plu;
}

// Per-target-location copy caches — a source row copied for a location is
// reused for every menu at that location (keeps intra-location sharing) and is
// never reused across locations (guarantees independence).
const itemCopyByLoc = new Map<string, Map<string, string>>(); // loc -> origItemId -> newItemId
const groupCopyByLoc = new Map<string, Map<string, string>>(); // loc -> origGroupId -> newGroupId

function locCache<T>(m: Map<string, Map<string, T>>, loc: string): Map<string, T> {
  let inner = m.get(loc);
  if (!inner) {
    inner = new Map();
    m.set(loc, inner);
  }
  return inner;
}

let createdItems = 0;
let createdGroups = 0;
let createdOptions = 0;

async function copyGroupForLocation(
  origGroupId: string,
  targetLoc: string,
): Promise<string> {
  const cache = locCache(groupCopyByLoc, targetLoc);
  const cached = cache.get(origGroupId);
  if (cached) return cached;

  const src = await prisma.modifierGroup.findUnique({
    where: { id: origGroupId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  if (!src) return origGroupId; // gone — leave the link as-is

  const gPlu = freshPlu("modifierGroup");
  const newGroup = await prisma.modifierGroup.create({
    data: {
      brandId: src.brandId,
      locationId: targetLoc,
      name: src.name,
      description: src.description,
      plu: gPlu,
      minSelections: src.minSelections,
      maxSelections: src.maxSelections,
      isRequired: src.isRequired,
      sortOrder: src.sortOrder,
      selectionType: src.selectionType,
      allowDuplicateSelections: src.allowDuplicateSelections,
      visibleToCustomers: src.visibleToCustomers,
      metadata: src.metadata as any,
    },
  });
  createdGroups++;
  for (const opt of src.options) {
    await prisma.modifierOption.create({
      data: {
        groupId: newGroup.id,
        modifierGroupIds: [],
        name: opt.name,
        description: opt.description,
        priceAdjustment: opt.priceAdjustment,
        plu: freshPlu("modifier"),
        pricesBySize: opt.pricesBySize as any,
        skuPlus: {},
        platformPricingOverrides: opt.platformPricingOverrides as any,
        imageUrl: opt.imageUrl,
        allergens: opt.allergens,
        isDefault: opt.isDefault,
        isAvailable: opt.isAvailable,
        visibleToCustomers: opt.visibleToCustomers,
        sortOrder: opt.sortOrder,
        deliveryTax: opt.deliveryTax,
        takeawayTax: opt.takeawayTax,
        eatInTax: opt.eatInTax,
        metadata: opt.metadata as any,
      },
    });
    createdOptions++;
  }
  cache.set(origGroupId, newGroup.id);
  return newGroup.id;
}

async function copyItemForLocation(
  origItemId: string,
  targetLoc: string,
): Promise<string> {
  const cache = locCache(itemCopyByLoc, targetLoc);
  const cached = cache.get(origItemId);
  if (cached) return cached;

  const src = await prisma.menuItem.findUnique({
    where: { id: origItemId },
    include: { modifierGroupLinks: true },
  });
  if (!src) return origItemId;

  const skus = Array.isArray(src.productSkus)
    ? (src.productSkus as any[]).map((s) => ({ ...s, plu: null }))
    : src.productSkus;

  const created = await prisma.menuItem.create({
    data: {
      brandId: src.brandId,
      locationId: targetLoc,
      name: src.name,
      description: src.description,
      basePrice: src.basePrice,
      imageUrl: src.imageUrl,
      sku: null,
      plu: freshPlu("product"),
      isAvailable: src.isAvailable,
      visibleToCustomers: src.visibleToCustomers,
      outOfStock: false,
      allergens: src.allergens,
      dietaryTags: src.dietaryTags,
      dietary: src.dietary as any,
      calories: src.calories,
      prepTime: src.prepTime,
      metadata: src.metadata as any,
      hasMultipleSkus: src.hasMultipleSkus,
      productSkus: skus as any,
      deliveryTax: src.deliveryTax,
      takeawayTax: src.takeawayTax,
      eatInTax: src.eatInTax,
      brandIds: src.brandIds,
      sortOrder: src.sortOrder,
      isInventoryTracked: src.isInventoryTracked,
      platformPricingOverrides: src.platformPricingOverrides as any,
    },
  });
  createdItems++;
  cache.set(origItemId, created.id);

  for (const link of src.modifierGroupLinks) {
    const newGroupId = await copyGroupForLocation(link.groupId, targetLoc);
    await prisma.modifierGroupOnItem.create({
      data: {
        itemId: created.id,
        groupId: newGroupId,
        sortOrder: link.sortOrder,
      },
    });
  }
  return created.id;
}

async function main() {
  console.log(
    `\n=== split-shared-menu-catalog — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"} ===\n`,
  );

  // Seed the used-PLU set with everything already in the DB so copies never
  // collide with an existing row.
  for (const t of ["menuItem", "modifierGroup", "modifierOption"] as const) {
    const rows = await (prisma[t] as any).findMany({
      where: { plu: { not: null } },
      select: { plu: true },
    });
    for (const r of rows) if (r.plu) usedPlus.add(r.plu);
  }

  // Snapshot: category -> menu, menu -> location (all menus, even deleted, so
  // sharing detection is complete).
  const categories = await prisma.menuCategory.findMany({
    select: { id: true, menuId: true },
  });
  const catToMenu = new Map(categories.map((c) => [c.id, c.menuId]));

  const allMenus = await prisma.menu.findMany({
    select: { id: true, locationId: true },
  });
  const menuLoc = new Map(allMenus.map((m) => [m.id, m.locationId]));

  // itemId -> { locations, menus }
  const itemLinks = await prisma.menuItemOnCategory.findMany({
    select: { categoryId: true, itemId: true },
  });
  const itemLocs = new Map<string, Set<string>>();
  const itemMenus = new Map<string, Set<string>>();
  for (const l of itemLinks) {
    const menuId = catToMenu.get(l.categoryId);
    if (!menuId) continue;
    if (!itemMenus.has(l.itemId)) itemMenus.set(l.itemId, new Set());
    itemMenus.get(l.itemId)!.add(menuId);
    const loc = menuLoc.get(menuId);
    if (loc) {
      if (!itemLocs.has(l.itemId)) itemLocs.set(l.itemId, new Set());
      itemLocs.get(l.itemId)!.add(loc);
    }
  }

  // groupId -> { locations } via item links
  const mgoiRows = await prisma.modifierGroupOnItem.findMany({
    select: { itemId: true, groupId: true },
  });
  const groupLocs = new Map<string, Set<string>>();
  const groupMenus = new Map<string, Set<string>>();
  for (const g of mgoiRows) {
    const locs = itemLocs.get(g.itemId);
    const menus = itemMenus.get(g.itemId);
    if (locs) {
      if (!groupLocs.has(g.groupId)) groupLocs.set(g.groupId, new Set());
      for (const loc of locs) groupLocs.get(g.groupId)!.add(loc);
    }
    if (menus) {
      if (!groupMenus.has(g.groupId)) groupMenus.set(g.groupId, new Set());
      for (const mn of menus) groupMenus.get(g.groupId)!.add(mn);
    }
  }

  // Home location for a shared row = location of the lowest menu id sharing it.
  const homeOf = (menuIds: Set<string>): string | null => {
    let best: string | null = null;
    let bestLoc: string | null = null;
    for (const mid of menuIds) {
      const loc = menuLoc.get(mid);
      if (!loc) continue;
      if (best === null || mid < best) {
        best = mid;
        bestLoc = loc;
      }
    }
    return bestLoc;
  };

  // Menus we actually rewrite: live menus with a location.
  const liveMenus = await prisma.menu.findMany({
    where: { locationId: { not: null }, deletedAt: null },
    select: { id: true, locationId: true, name: true },
    orderBy: { id: "asc" },
  });

  // Plan.
  type ItemFork = { menuId: string; menuName: string; loc: string; itemId: string };
  type GroupFork = { itemId: string; groupId: string; loc: string };
  const itemForks: ItemFork[] = [];
  const forkedItemInMenu = new Set<string>(); // `${menuId}|${itemId}`

  for (const m of liveMenus) {
    const L = m.locationId!;
    const linkItems = new Set(
      itemLinks
        .filter((l) => catToMenu.get(l.categoryId) === m.id)
        .map((l) => l.itemId),
    );
    for (const itemId of linkItems) {
      const locs = itemLocs.get(itemId);
      if (!locs || locs.size <= 1) continue; // single-location item — private already
      const home = homeOf(itemMenus.get(itemId) ?? new Set());
      if (home === L) continue; // this location keeps the original
      itemForks.push({ menuId: m.id, menuName: m.name, loc: L, itemId });
      forkedItemInMenu.add(`${m.id}|${itemId}`);
    }
  }

  const groupForks: GroupFork[] = [];
  const seenGroupFork = new Set<string>(); // `${itemId}|${groupId}`
  for (const m of liveMenus) {
    const L = m.locationId!;
    const linkItems = new Set(
      itemLinks
        .filter((l) => catToMenu.get(l.categoryId) === m.id)
        .map((l) => l.itemId),
    );
    for (const itemId of linkItems) {
      if (forkedItemInMenu.has(`${m.id}|${itemId}`)) continue; // copy already has private groups
      const groups = mgoiRows
        .filter((g) => g.itemId === itemId)
        .map((g) => g.groupId);
      for (const groupId of groups) {
        const locs = groupLocs.get(groupId);
        if (!locs || locs.size <= 1) continue;
        const home = homeOf(groupMenus.get(groupId) ?? new Set());
        if (home === L) continue;
        const key = `${itemId}|${groupId}`;
        if (seenGroupFork.has(key)) continue;
        seenGroupFork.add(key);
        groupForks.push({ itemId, groupId, loc: L });
      }
    }
  }

  console.log(`Live menus with a location: ${liveMenus.length}`);
  console.log(`Shared items to fork:       ${itemForks.length}`);
  console.log(`Shared groups to fork:      ${groupForks.length}\n`);

  for (const f of itemForks)
    console.log(`  [item]  menu "${f.menuName}" (${f.menuId}) → new copy of item ${f.itemId}`);
  for (const f of groupForks)
    console.log(`  [group] item ${f.itemId} → new copy of group ${f.groupId}`);

  if (!APPLY) {
    console.log(`\nDry run complete — set APPLY=true to write.\n`);
    return;
  }

  // Apply item-forks first (so kept items end up single-location), then groups.
  for (const f of itemForks) {
    const newItemId = await copyItemForLocation(f.itemId, f.loc);
    // Re-point this menu's category links from the shared item to the copy.
    const cats = categories.filter((c) => c.menuId === f.menuId).map((c) => c.id);
    const links = await prisma.menuItemOnCategory.findMany({
      where: { categoryId: { in: cats }, itemId: f.itemId },
    });
    for (const link of links) {
      await prisma.menuItemOnCategory.delete({
        where: { categoryId_itemId: { categoryId: link.categoryId, itemId: link.itemId } },
      });
      await prisma.menuItemOnCategory.create({
        data: {
          categoryId: link.categoryId,
          itemId: newItemId,
          sortOrder: link.sortOrder,
          priceOverride: link.priceOverride,
          isVisible: link.isVisible,
        },
      });
    }
  }

  for (const f of groupForks) {
    // The item may have been relinked already; only act if the shared link
    // still exists.
    const existing = await prisma.modifierGroupOnItem.findUnique({
      where: { itemId_groupId: { itemId: f.itemId, groupId: f.groupId } },
    });
    if (!existing) continue;
    const newGroupId = await copyGroupForLocation(f.groupId, f.loc);
    if (newGroupId === f.groupId) continue;
    await prisma.modifierGroupOnItem.delete({
      where: { itemId_groupId: { itemId: f.itemId, groupId: f.groupId } },
    });
    await prisma.modifierGroupOnItem.create({
      data: {
        itemId: f.itemId,
        groupId: newGroupId,
        sortOrder: existing.sortOrder,
      },
    });
  }

  console.log(
    `\nApplied. Created ${createdItems} items, ${createdGroups} modifier groups, ${createdOptions} modifier options.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
