import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { MenusService } from "../menus.service";
import { MenuWriterService } from "./menu-writer.service";
import { classifyAiMenu, type AiMenuDraft } from "./ai-menu.classifier";

// ── AI menu importer (commit) ───────────────────────────────────────────────
//
// Takes the operator-reviewed draft, creates a fresh DRAFT menu, and writes
// the catalog through the shared MenuWriterService (same path as Uber /
// Deliveroo / HubRise). Then back-fills each multi-size item's
// productSkus[].modifierGroups with the local group ids so size variants
// surface their modifiers in the storefront / POS.

interface CommitArgs {
  tenantId: string;
  brandId: string;
  menuName?: string;
  menuType?: string;
  locationId?: string;
  draft: AiMenuDraft;
}

/** What the draft is asking to create — for the failure log. */
function countDraft(draft: AiMenuDraft) {
  const categories = draft.categories?.length ?? 0;
  const items = (draft.categories ?? []).reduce(
    (n, c) => n + (c.items?.length ?? 0),
    0,
  );
  const groups = draft.modifierGroups?.length ?? 0;
  const options = (draft.modifierGroups ?? []).reduce(
    (n, g) => n + (g.options?.length ?? 0),
    0,
  );
  return { categories, items, groups, options };
}

@Injectable()
export class AiMenuImporter {
  private readonly logger = new Logger(AiMenuImporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly writer: MenuWriterService,
  ) {}

  async commit(args: CommitArgs) {
    const draft = args.draft;
    if (!draft || !Array.isArray(draft.categories) || draft.categories.length === 0) {
      throw new BadRequestException("Nothing to import — the draft has no categories.");
    }

    const name =
      (args.menuName ?? "").trim() ||
      (draft.menuName ?? "").trim() ||
      "Imported menu";

    // MenusService.create enforces brand access + applies defaults.
    const menu = await this.menus.create(args.brandId, args.tenantId, {
      name,
      ...(args.menuType ? { menuType: args.menuType } : {}),
      ...(args.locationId ? { locationId: args.locationId } : {}),
    } as any);

    try {
      const normalized = classifyAiMenu(draft, menu.id);
      const result = await this.writer.apply({
        menuId: menu.id,
        tenantId: args.tenantId,
        brandId: menu.brandId,
        locationId: menu.locationId,
        normalized,
      });

      await this.backfillMultiSkuGroups(menu.id, menu.brandId);

      this.logger.log(
        `AI menu import committed: menu=${menu.id} created=${result.createdCount} warnings=${result.warnings.length}`,
      );
      return { menuId: menu.id, menuName: menu.name, ...result };
    } catch (err: any) {
      // Don't leave an empty orphan menu behind on a failed write.
      await this.menus.remove(menu.id, args.tenantId).catch(() => undefined);

      // A bare 500 tells the operator nothing and tells us less. Log the
      // failure WITH the shape of what was being written — the size of the
      // import is the thing most likely to have caused it, and a stack alone
      // does not carry that.
      const counts = countDraft(draft);
      this.logger.error(
        `AI menu import FAILED menu=${menu.id} brand=${args.brandId} ` +
          `(${counts.categories} categories, ${counts.items} items, ` +
          `${counts.groups} option groups, ${counts.options} options): ` +
          `${err?.code ? `[${err.code}] ` : ""}${err?.message ?? err}`,
        err?.stack,
      );

      // Prisma closes an interactive transaction that overruns its timeout and
      // every later query in it fails with P2028. On a big menu that is not a
      // bug the operator can act on from "Internal server error", so say what
      // actually happened and what it depends on.
      const msg = String(err?.message ?? "");
      if (err?.code === "P2028" || /transaction/i.test(msg) && /closed|timeout|expired/i.test(msg)) {
        throw new BadRequestException(
          `This menu was too large to write in one go — ${counts.items} items and ` +
            `${counts.options} options exceeded the import transaction's time limit. ` +
            `Nothing was created. Splitting it into smaller menus will import; ` +
            `the size limit itself is ours to fix.`,
        );
      }
      throw err;
    }
  }

  /**
   * After the writer creates products + groups + links, multi-SKU items
   * still have empty productSkus[].modifierGroups (local ids weren't known
   * at classify time). Resolve them from the ModifierGroupOnItem rows so a
   * size variant knows which modifier groups apply.
   */
  private async backfillMultiSkuGroups(menuId: string, brandId: string): Promise<void> {
    const items = await this.prisma.menuItem.findMany({
      where: {
        brandId,
        platformSource: "ai",
        hasMultipleSkus: true,
        menuIds: { has: menuId },
      },
      select: {
        id: true,
        productSkus: true,
        modifierGroupLinks: { select: { groupId: true } },
      },
    });

    for (const item of items) {
      const groupIds = item.modifierGroupLinks.map((l) => l.groupId);
      if (!groupIds.length) continue;
      const skus = Array.isArray(item.productSkus) ? (item.productSkus as any[]) : [];
      if (!skus.length) continue;
      const next = skus.map((s) => ({ ...s, modifierGroups: groupIds }));
      await this.prisma.menuItem.update({
        where: { id: item.id },
        data: { productSkus: next as any },
      });
    }
  }
}
