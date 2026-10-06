import { Logger } from "@nestjs/common";
import { buildGuideNameKey } from "@orderhub/shared";

const logger = new Logger("BuildGuideCarry");

/**
 * Guides are keyed by brand + product NAME (see BuildGuide in schema.prisma),
 * so a rename or a duplicate would otherwise leave the product without its
 * chart. These keep the guide attached. Clones and master menus need nothing:
 * deepCopyItemTx keeps both brand and name, so the copy shares the guide.
 *
 * Best-effort by design — a guide that fails to follow must never fail the
 * product save that triggered it.
 */

type Db = {
  buildGuide: { findUnique: Function; create: Function; update: Function };
  menuItem: { findMany: Function };
};

async function findGuide(db: Db, brandId: string, nameKey: string) {
  return db.buildGuide.findUnique({ where: { brandId_nameKey: { brandId, nameKey } } });
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
): Promise<"moved" | "copied" | "none"> {
  try {
    const oldKey = buildGuideNameKey(args.oldName);
    const newKey = buildGuideNameKey(args.newName);
    if (!oldKey || !newKey || oldKey === newKey) return "none";
    const guide = await findGuide(db, args.brandId, oldKey);
    if (!guide) return "none";
    if (await findGuide(db, args.brandId, newKey)) return "none";

    const siblings: Array<{ name: string }> = await db.menuItem.findMany({
      where: { brandId: args.brandId, id: { not: args.itemId } },
      select: { name: true },
    });
    const stillUsed = siblings.some((s) => buildGuideNameKey(s.name) === oldKey);

    if (stillUsed) {
      await db.buildGuide.create({ data: copyData(guide, newKey, args.newName) });
      return "copied";
    }
    await db.buildGuide.update({ where: { id: guide.id }, data: { nameKey: newKey, name: args.newName } });
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
): Promise<boolean> {
  try {
    const fromKey = buildGuideNameKey(args.fromName);
    const newKey = buildGuideNameKey(args.newName);
    if (!fromKey || !newKey || fromKey === newKey) return false;
    const guide = await findGuide(db, args.brandId, fromKey);
    if (!guide || (await findGuide(db, args.brandId, newKey))) return false;
    await db.buildGuide.create({ data: copyData(guide, newKey, args.newName) });
    return true;
  } catch (err: any) {
    logger.warn(`Guide not copied to "${args.newName}": ${err?.message ?? err}`);
    return false;
  }
}

function copyData(guide: any, nameKey: string, name: string) {
  return {
    tenantId: guide.tenantId,
    brandId: guide.brandId,
    nameKey,
    name,
    steps: guide.steps ?? [],
    packNote: guide.packNote ?? null,
    updatedBy: guide.updatedBy ?? null,
  };
}
