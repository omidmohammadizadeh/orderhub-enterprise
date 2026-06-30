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
    } catch (err) {
      // Don't leave an empty orphan menu behind on a failed write.
      await this.menus.remove(menu.id, args.tenantId).catch(() => undefined);
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
