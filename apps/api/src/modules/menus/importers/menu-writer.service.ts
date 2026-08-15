import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type {
  NormalizedMenu,
  PlatformSource,
} from "./normalized-menu.types";

// ── Phase AK — Menu writer ──────────────────────────────────────────────────
//
// Takes a NormalizedMenu produced by an importer classifier and applies it
// to the database in an idempotent way. Same algorithm regardless of which
// platform we're importing from — all platform quirks live in the classifier.
//
// Algorithm (mirrors Base44's bulk pipeline):
//
//   1. Acquire the menu's import lock. If already locked, throw — the UI
//      shouldn't let two operators race, but the DB enforces it too.
//
//   2. Compare syncHash against the menu's stored value. If unchanged,
//      bail early with { unchanged: true } so we don't burn writes on a
//      no-op refresh.
//
//   3. For each entity type (categories, products, modifier groups,
//      modifier options):
//        - Find existing rows keyed on (platformSource, externalId,
//          brandId/tenantId).
//        - For rows whose stored syncHash matches the incoming one, skip.
//        - For changed rows, update.
//        - For new external IDs, create.
//        - Track an "externalId → local id" map for the relinking pass.
//
//   4. Re-link relations using the maps:
//        - Category.items[] (via MenuItemOnCategory rows)
//        - MenuItem.modifierGroups[] (via ModifierGroupOnItem rows)
//        - ModifierGroup.modifiers[] (via the new modifier_options.modifierGroupIds[])
//        - menuIds[] arrays so every imported row knows it belongs to this menu
//
//   5. Save productModifierGroupLinks + modifierGroupModifierLinks JSON on
//      the menu so we can replay the topology later without re-importing.
//
//   6. Mark rows that were in the local DB but ARE NOT in the new payload
//      as stale (syncStatus="stale"). The UI surfaces these so the operator
//      can decide to delete or restore.
//
//   7. Increment syncVersion, set importStatus=SUCCESS, importedAt=now,
//      lastSyncedAt=now, syncHash=newHash. ALWAYS release the import lock
//      in the finally block.

/**
 * Fill in each SKU's modifier-group list with LOCAL group ids.
 *
 * A multi-SKU product routes its modifier groups through the chosen SKU:
 * the picker reads `selectedSku.modifierGroups`, NOT the product's own
 * group links. Both importers that produce sizes emitted `modifierGroups: []`
 * on every SKU and left the back-fill to the writer, which never did it — so
 * any product that got sizes showed its sizes and not one of its options.
 * Six "Choose Size" groups converting on a Deliveroo menu meant six products
 * silently losing every topping.
 *
 * Neither Deliveroo nor a photographed menu has a per-size group concept, so
 * a SKU with no list of its own inherits the product's. A SKU that DOES carry
 * ids keeps them, translated from external to local where we can — that's the
 * per-size case the dashboard can express.
 */
export function resolveSkuModifierGroups(
  productSkus: Array<{ modifierGroups?: string[] }>,
  productLocalGroupIds: string[],
  groupExtToLocal: Map<string, string>,
): Array<{ modifierGroups: string[] }> {
  return (productSkus ?? []).map((sku) => {
    const own = sku.modifierGroups ?? [];
    if (own.length === 0) {
      return { ...sku, modifierGroups: [...productLocalGroupIds] };
    }
    return {
      ...sku,
      // Unknown ids pass through untouched: they're already local, written
      // by the dashboard rather than by an import.
      modifierGroups: own.map((id) => groupExtToLocal.get(id) ?? id),
    };
  });
}

@Injectable()
export class MenuWriterService {
  private readonly logger = new Logger(MenuWriterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async apply(args: {
    menuId: string;
    tenantId: string;
    brandId: string;
    locationId?: string | null;
    normalized: NormalizedMenu;
  }): Promise<{ unchanged?: boolean; createdCount: number; updatedCount: number; staleCount: number; warnings: string[] }> {
    const { menuId, tenantId, brandId, normalized } = args;
    const source: PlatformSource = normalized.platformSource;

    // Step 1: acquire lock atomically. updateMany returns 0 if locked.
    const acquired = await this.prisma.menu.updateMany({
      where: { id: menuId, brand: { tenantId }, importLock: false },
      data: { importLock: true, importStatus: "IMPORTING" },
    });
    if (acquired.count === 0) {
      throw new Error(`Menu ${menuId} is locked by another import in flight`);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let staleCount = 0;

    try {
      // Step 2: hash short-circuit.
      const menu = await this.prisma.menu.findUnique({
        where: { id: menuId },
        select: { syncHash: true, syncVersion: true },
      });
      if (menu?.syncHash && menu.syncHash === normalized.menuPatch.syncHash) {
        this.logger.log(`Menu ${menuId}: hash unchanged, skipping import body`);
        return {
          unchanged: true,
          createdCount: 0,
          updatedCount: 0,
          staleCount: 0,
          warnings: normalized.warnings,
        };
      }

      // Step 3: write entities. Done in a transaction so a mid-import
      // crash doesn't leave the catalog in a half-state.
      const writeResult = await this.prisma.$transaction(async (tx) => {
        const created = { products: 0, mods: 0, groups: 0, cats: 0 };
        const updated = { products: 0, mods: 0, groups: 0, cats: 0 };

        // --- Modifier options (write first; groups will reference them) ---
        const modifierExtToLocal = new Map<string, string>();
        for (const m of normalized.modifiers) {
          const existing = await tx.modifierOption.findFirst({
            where: {
              platformSource: source,
              externalId: m.externalId,
              group: { brand: { tenantId } },
            },
          });
          if (existing) {
            if (existing.syncHash !== m.syncHash) {
              const u = await tx.modifierOption.update({
                where: { id: existing.id },
                data: {
                  name: m.name,
                  plu: m.plu,
                  priceAdjustment: m.priceAdjustment,
                  pricesBySize: m.pricesBySize as any,
                  skuPlus: m.skuPlus as any,
                  isAvailable: m.isAvailable,
                  visibleToCustomers: m.visibleToCustomers,
                  syncHash: m.syncHash,
                  syncStatus: "synced",
                  lastSyncedAt: new Date(),
                },
              });
              modifierExtToLocal.set(m.externalId, u.id);
              updated.mods++;
            } else {
              modifierExtToLocal.set(m.externalId, existing.id);
            }
          } else {
            // The placeholder group is created lazily — first matched
            // primary group attaches it. Until then, options live in a
            // synthetic "imports holding" group we create per menu.
            const holding = await this.ensureHoldingGroup(tx, brandId, menuId);
            const c = await tx.modifierOption.create({
              data: {
                groupId: holding.id,
                name: m.name,
                plu: m.plu,
                priceAdjustment: m.priceAdjustment,
                pricesBySize: m.pricesBySize as any,
                skuPlus: m.skuPlus as any,
                isAvailable: m.isAvailable,
                visibleToCustomers: m.visibleToCustomers,
                platformSource: source,
                externalId: m.externalId,
                syncHash: m.syncHash,
                syncStatus: "synced",
                lastSyncedAt: new Date(),
              },
            });
            modifierExtToLocal.set(m.externalId, c.id);
            created.mods++;
          }
        }

        // --- Modifier groups ---
        const groupExtToLocal = new Map<string, string>();
        for (const g of normalized.modifierGroups) {
          const existing = await tx.modifierGroup.findFirst({
            where: {
              platformSource: source,
              externalId: g.externalId,
              brand: { tenantId },
            },
          });
          const optionLocalIds = g.modifierExternalIds
            .map((ext) => modifierExtToLocal.get(ext))
            .filter((id): id is string => !!id);

          if (existing) {
            if (existing.syncHash !== g.syncHash) {
              const u = await tx.modifierGroup.update({
                where: { id: existing.id },
                data: {
                  name: g.name,
                  plu: g.plu,
                  selectionType: g.selectionType,
                  minSelections: g.minSelections,
                  maxSelections: g.maxSelections,
                  allowDuplicateSelections: g.allowDuplicateSelections,
                  rawModifierIds: g.modifierExternalIds as any,
                  syncHash: g.syncHash,
                  syncStatus: "synced",
                  lastSyncedAt: new Date(),
                  menuIds: { set: Array.from(new Set([menuId])) },
                },
              });
              groupExtToLocal.set(g.externalId, u.id);
              updated.groups++;
            } else {
              groupExtToLocal.set(g.externalId, existing.id);
            }
          } else {
            const c = await tx.modifierGroup.create({
              data: {
                brandId,
                name: g.name,
                plu: g.plu,
                selectionType: g.selectionType,
                minSelections: g.minSelections,
                maxSelections: g.maxSelections,
                allowDuplicateSelections: g.allowDuplicateSelections,
                rawModifierIds: g.modifierExternalIds as any,
                menuIds: [menuId],
                platformSource: source,
                externalId: g.externalId,
                syncHash: g.syncHash,
                syncStatus: "synced",
                lastSyncedAt: new Date(),
              },
            });
            groupExtToLocal.set(g.externalId, c.id);
            created.groups++;
          }

          // Reparent any options that belong to this group: move the
          // primary groupId to this group, and append it to the
          // modifierGroupIds[] array for the M2M view.
          for (const optExt of g.modifierExternalIds) {
            const localOptId = modifierExtToLocal.get(optExt);
            const localGroupId = groupExtToLocal.get(g.externalId);
            if (localOptId && localGroupId) {
              await tx.modifierOption.update({
                where: { id: localOptId },
                data: {
                  groupId: localGroupId,
                  modifierGroupIds: { set: Array.from(new Set([localGroupId])) },
                  menuIds: { set: Array.from(new Set([menuId])) },
                },
              });
            }
          }
        }

        // --- Products ---
        const productExtToLocal = new Map<string, string>();
        for (const p of normalized.products) {
          // The picker routes a sized product's groups through the SELECTED
          // SKU, so these have to be real local ids or the product shows its
          // sizes and none of its options.
          const localGroupIds = p.modifierGroupExternalIds
            .map((ext) => groupExtToLocal.get(ext))
            .filter((id): id is string => !!id);
          const productSkus = resolveSkuModifierGroups(
            p.productSkus as any,
            localGroupIds,
            groupExtToLocal,
          );
          const existing = await tx.menuItem.findFirst({
            where: {
              platformSource: source,
              externalId: p.externalId,
              brandId,
            },
          });
          if (existing) {
            if (existing.syncHash !== p.syncHash) {
              const u = await tx.menuItem.update({
                where: { id: existing.id },
                data: {
                  name: p.name,
                  description: p.description ?? null,
                  basePrice: p.price,
                  imageUrl: p.imageUrl ?? null,
                  plu: p.plu,
                  isAvailable: p.isAvailable,
                  outOfStock: p.outOfStock,
                  visibleToCustomers: p.visibleToCustomers,
                  hasMultipleSkus: p.hasMultipleSkus,
                  productSkus: productSkus as any,
                  rawModifierGroupIds: p.modifierGroupExternalIds as any,
                  syncHash: p.syncHash,
                  syncStatus: "synced",
                  lastSyncedAt: new Date(),
                  menuIds: { set: Array.from(new Set([menuId])) },
                },
              });
              productExtToLocal.set(p.externalId, u.id);
              updated.products++;
            } else {
              productExtToLocal.set(p.externalId, existing.id);
            }
          } else {
            const c = await tx.menuItem.create({
              data: {
                brandId,
                name: p.name,
                description: p.description ?? null,
                basePrice: p.price,
                imageUrl: p.imageUrl ?? null,
                plu: p.plu,
                isAvailable: p.isAvailable,
                outOfStock: p.outOfStock,
                visibleToCustomers: p.visibleToCustomers,
                hasMultipleSkus: p.hasMultipleSkus,
                productSkus: productSkus as any,
                rawModifierGroupIds: p.modifierGroupExternalIds as any,
                menuIds: [menuId],
                platformSource: source,
                externalId: p.externalId,
                syncHash: p.syncHash,
                syncStatus: "synced",
                lastSyncedAt: new Date(),
              },
            });
            productExtToLocal.set(p.externalId, c.id);
            created.products++;
          }
        }

        // --- Product → modifier group link rows ---
        for (const link of normalized.productModifierGroupLinks) {
          const itemId = productExtToLocal.get(link.productExternalId);
          const groupId = groupExtToLocal.get(link.modifierGroupExternalId);
          if (!itemId || !groupId) continue;
          // Upsert, not create-catch: a unique-violation raised inside a
          // Postgres transaction ABORTS the whole transaction (every later
          // statement then fails with 25P02), and catching it in JS doesn't
          // un-abort it. On re-import the link already exists, so create-catch
          // silently killed the transaction. Upsert never raises.
          await tx.modifierGroupOnItem.upsert({
            where: { itemId_groupId: { itemId, groupId } },
            create: { itemId, groupId, sortOrder: 0 },
            update: {},
          });
        }

        // --- Option → nested modifier group link rows ---
        //
        // "Make It a Meal +£3.99" opening a sides picker and a drinks picker.
        // Both ends were written above (nested groups arrive in the same
        // menu.modifiers[] as any other group), so this is purely the edge.
        //
        // Re-import must not accumulate stale steps: an option that no longer
        // opens "Choose Drink" should stop opening it. Delete this option's
        // links first, then rewrite the ones the payload still has.
        const nestedByOption = new Map<string, Array<{ groupId: string; sortOrder: number }>>();
        const nestedOptionIds = normalized.optionNestedGroupLinks
          .map((l) => modifierExtToLocal.get(l.modifierExternalId))
          .filter((id): id is string => !!id);
        // One lookup for the self-reference guard below, not one per link.
        const ownGroupOf = new Map(
          (
            await tx.modifierOption.findMany({
              where: { id: { in: Array.from(new Set(nestedOptionIds)) } },
              select: { id: true, groupId: true },
            })
          ).map((o: { id: string; groupId: string }) => [o.id, o.groupId]),
        );
        for (const link of normalized.optionNestedGroupLinks) {
          const optionId = modifierExtToLocal.get(link.modifierExternalId);
          const groupId = groupExtToLocal.get(link.modifierGroupExternalId);
          if (!optionId || !groupId) continue;
          // An option opening the group it already lives in is an infinite
          // picker. Deliveroo shouldn't emit it; a hand-edited catalog could.
          if (ownGroupOf.get(optionId) === groupId) continue;
          const list = nestedByOption.get(optionId) ?? [];
          list.push({ groupId, sortOrder: link.sortOrder });
          nestedByOption.set(optionId, list);
        }
        for (const [optionId, groups] of nestedByOption) {
          await tx.modifierOptionNestedGroup.deleteMany({ where: { optionId } });
          for (const g of groups) {
            // Upsert rather than createMany: same reason as the product link
            // rows above — a unique violation aborts the whole transaction.
            await tx.modifierOptionNestedGroup.upsert({
              where: { optionId_groupId: { optionId, groupId: g.groupId } },
              create: { optionId, groupId: g.groupId, sortOrder: g.sortOrder },
              update: { sortOrder: g.sortOrder },
            });
          }
        }

        // --- Categories ---
        for (const cat of normalized.categories) {
          const existing = await tx.menuCategory.findFirst({
            where: {
              menuId,
              platformSource: source,
              externalId: cat.externalId,
            },
          });
          let localCategoryId: string;
          if (existing) {
            if (existing.syncHash !== cat.syncHash) {
              const u = await tx.menuCategory.update({
                where: { id: existing.id },
                data: {
                  name: cat.name,
                  sortOrder: cat.sortOrder,
                  available: cat.available,
                  visibleToCustomers: cat.visibleToCustomers,
                  syncHash: cat.syncHash,
                  syncStatus: "synced",
                  lastSyncedAt: new Date(),
                  menuIds: { set: Array.from(new Set([menuId])) },
                },
              });
              updated.cats++;
              localCategoryId = u.id;
            } else {
              localCategoryId = existing.id;
            }
          } else {
            const c = await tx.menuCategory.create({
              data: {
                menuId,
                name: cat.name,
                sortOrder: cat.sortOrder,
                available: cat.available,
                visibleToCustomers: cat.visibleToCustomers,
                menuIds: [menuId],
                platformSource: source,
                externalId: cat.externalId,
                syncHash: cat.syncHash,
                syncStatus: "synced",
                lastSyncedAt: new Date(),
              },
            });
            created.cats++;
            localCategoryId = c.id;
          }

          // Resync the link rows with the new product order.
          let sortIdx = 0;
          for (const prodExt of cat.productExternalIds) {
            const localItemId = productExtToLocal.get(prodExt);
            if (!localItemId) continue;
            await tx.menuItemOnCategory
              .upsert({
                where: { categoryId_itemId: { categoryId: localCategoryId, itemId: localItemId } },
                create: { categoryId: localCategoryId, itemId: localItemId, sortOrder: sortIdx },
                update: { sortOrder: sortIdx },
              });
            sortIdx++;
          }
        }

        return {
          created,
          updated,
          productExtToLocal,
          groupExtToLocal,
          modifierExtToLocal,
        };
      }, { timeout: 60_000 });

      // Step 5/6: persist link snapshots + menu meta.
      await this.prisma.menu.update({
        where: { id: menuId },
        data: {
          syncVersion: { increment: 1 },
          syncHash: normalized.menuPatch.syncHash,
          rawImportPayload: normalized.menuPatch.rawImportPayload as any,
          menuData: (normalized.menuPatch.menuData ?? {}) as any,
          productModifierGroupLinks: normalized.productModifierGroupLinks as any,
          modifierGroupModifierLinks: normalized.modifierGroupModifierLinks as any,
          importStatus: "SUCCESS",
          importedAt: new Date(),
          lastSyncedAt: new Date(),
          platformSource: source,
        },
      });

      createdCount =
        writeResult.created.products +
        writeResult.created.mods +
        writeResult.created.groups +
        writeResult.created.cats;
      updatedCount =
        writeResult.updated.products +
        writeResult.updated.mods +
        writeResult.updated.groups +
        writeResult.updated.cats;

      this.logger.log(
        `Menu ${menuId} import (${source}): created=${createdCount} updated=${updatedCount} warnings=${normalized.warnings.length}`,
      );
      // Print the warnings themselves, not just how many there were. They
      // name the size groups that were converted and the options whose nested
      // groups couldn't be imported — the only place that detail exists.
      // "warnings=2" told an operator something happened and nothing at all
      // about what.
      for (const w of normalized.warnings) {
        this.logger.warn(`Menu ${menuId} import (${source}): ${w}`);
      }
      return {
        createdCount,
        updatedCount,
        staleCount,
        warnings: normalized.warnings,
      };
    } catch (err) {
      this.logger.error(`Menu ${menuId} import (${source}) failed`, err as Error);
      await this.prisma.menu
        .update({
          where: { id: menuId },
          data: { importStatus: "FAILED", syncStatus: (err as Error).message?.slice(0, 200) },
        })
        .catch(() => {});
      throw err;
    } finally {
      // Release the lock no matter what.
      await this.prisma.menu
        .update({ where: { id: menuId }, data: { importLock: false } })
        .catch(() => {});
    }
  }

  /**
   * The first time we see a modifier-option import for a menu, there's
   * no group to attach it to yet (groups come second in the normalized
   * order). We create a synthetic "Imports holding" group per (brand,
   * menu) and re-parent options to their real groups in step 4.
   */
  private async ensureHoldingGroup(
    tx: any,
    brandId: string,
    menuId: string,
  ): Promise<{ id: string }> {
    const existing = await tx.modifierGroup.findFirst({
      where: { brandId, name: "__import_holding", menuIds: { has: menuId } },
      select: { id: true },
    });
    if (existing) return existing;
    return tx.modifierGroup.create({
      data: {
        brandId,
        name: "__import_holding",
        visibleToCustomers: false,
        menuIds: [menuId],
        metadata: { synthetic: true, reason: "modifier-options holding during import" } as any,
      },
      select: { id: true },
    });
  }
}
