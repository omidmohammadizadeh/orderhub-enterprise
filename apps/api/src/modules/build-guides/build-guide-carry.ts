import { Logger } from "@nestjs/common";
import { buildGuideNameKey } from "@orderhub/shared";

const logger = new Logger("BuildGuideCarry");

/**
 * Guides are keyed by brand + product NAME (see BuildGuide in schema.prisma),
 * so a rename or a duplicate would otherwise leave the product without its
 * chart. These keep the guide attached. Clones and master menus need nothing:
 * deepCopyItemTx keeps both brand and name, so the copy shares the guide —
 * until "Tag brand" moves the copy to the new shop's brand (copyGuidesToBrand).
 *
 * Best-effort by design — a guide that fails to follow must never fail the
 * product save that triggered it.
 */

/** Every table keyed by brand + product name. Assembly charts ride the same rails. */
export type NameKeyedModel = "buildGuide" | "assemblyChart";

type Db = Record<string, any>;

async function findGuide(db: Db, brandId: string, nameKey: string, model: NameKeyedModel) {
  return db[model].findUnique({ where: { brandId_nameKey: { brandId, nameKey } } });
}

/**
 * A product was renamed. Move its guide to the new name — unless another
 * product of the brand still carries the old name (a clone at another
 * location, say), in which case COPY it so both keep a chart. Never
 * overwrites a guide already saved under the new name.
 */
export async function carryGuideOnRename(
  db: Db,
  args: { itemId: string; brandId: string; oldName: string; newName: string },
  model: NameKeyedModel = "buildGuide",
): Promise<"moved" | "copied" | "none"> {
  try {
    const oldKey = buildGuideNameKey(args.oldName);
    const newKey = buildGuideNameKey(args.newName);
    if (!oldKey || !newKey || oldKey === newKey) return "none";
    const guide = await findGuide(db, args.brandId, oldKey, model);
    if (!guide) return "none";
    if (await findGuide(db, args.brandId, newKey, model)) return "none";

    const siblings: Array<{ name: string }> = await db.menuItem.findMany({
      where: { brandId: args.brandId, id: { not: args.itemId } },
      select: { name: true },
    });
    const stillUsed = siblings.some((s) => buildGuideNameKey(s.name) === oldKey);

    if (stillUsed) {
      await db[model].create({ data: copyData(guide, newKey, args.newName) });
      return "copied";
    }
    await db[model].update({
      where: { id: guide.id },
      data: {
        nameKey: newKey,
        name: args.newName,
        // An assembly chart's header follows the product name unless someone
        // typed a custom title — a renamed product must not keep its old
        // name on the printed board.
        ...(guide.title !== undefined && sameTitle(guide.title, args.oldName) ? { title: args.newName } : {}),
      },
    });
    return "moved";
  } catch (err: any) {
    logger.warn(`Guide did not follow rename of ${args.itemId}: ${err?.message ?? err}`);
    return "none";
  }
}

/** A product was duplicated as `newName` — give the copy its own guide. */
export async function copyGuideToName(
  db: Db,
  args: { brandId: string; fromName: string; newName: string },
  model: NameKeyedModel = "buildGuide",
): Promise<boolean> {
  try {
    const fromKey = buildGuideNameKey(args.fromName);
    const newKey = buildGuideNameKey(args.newName);
    if (!fromKey || !newKey || fromKey === newKey) return false;
    const guide = await findGuide(db, args.brandId, fromKey, model);
    if (!guide || (await findGuide(db, args.brandId, newKey, model))) return false;
    await db[model].create({ data: copyData(guide, newKey, args.newName) });
    return true;
  } catch (err: any) {
    logger.warn(`Guide not copied to "${args.newName}": ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Products moved to another brand ("Tag brand" on a copied menu) — give the
 * new brand its own copy of every guide the products had under their old
 * brand. A copy, not a move: the source brand keeps selling them. Never
 * overwrites a guide the new brand already has. Returns how many were copied.
 */
export async function copyGuidesToBrand(
  db: Db,
  args: { items: Array<{ brandId: string; name: string }>; toBrandId: string },
  model: NameKeyedModel = "buildGuide",
): Promise<number> {
  try {
    const wanted = new Map<string, { brandId: string; nameKey: string }>();
    for (const it of args.items) {
      const nameKey = buildGuideNameKey(it.name);
      if (!nameKey || !it.brandId || it.brandId === args.toBrandId) continue;
      wanted.set(`${it.brandId}|${nameKey}`, { brandId: it.brandId, nameKey });
    }
    if (!wanted.size) return 0;
    const sources: any[] = await db[model].findMany({ where: { OR: [...wanted.values()] } });
    const taken = new Set<string>(
      (
        await db[model].findMany({
          where: { brandId: args.toBrandId, nameKey: { in: sources.map((g) => g.nameKey) } },
          select: { nameKey: true },
        })
      ).map((g: any) => g.nameKey),
    );
    const data = [];
    for (const g of sources) {
      if (taken.has(g.nameKey)) continue;
      taken.add(g.nameKey); // two old brands with the same product — first wins
      data.push({ ...copyData(g, g.nameKey, g.name), brandId: args.toBrandId });
    }
    if (!data.length) return 0;
    const res = await db[model].createMany({ data, skipDuplicates: true });
    return res?.count ?? data.length;
  } catch (err: any) {
    logger.warn(`Guides not copied to brand ${args.toBrandId}: ${err?.message ?? err}`);
    return 0;
  }
}

function sameTitle(a: unknown, b: string) {
  return String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

function copyData(row: any, nameKey: string, name: string) {
  // Everything but identity — works for any brand+name keyed table.
  const { id: _id, createdAt: _c, updatedAt: _u, nameKey: _k, name: oldName, ...rest } = row ?? {};
  // A title that was just the product name follows the new name too.
  if (rest.title !== undefined && sameTitle(rest.title, String(oldName ?? ""))) rest.title = name;
  return { ...rest, nameKey, name };
}
