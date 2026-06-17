import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PluService } from "./plu.service";
import { QUEUES, MENU_JOBS } from "@orderhub/shared";
import type {
  CreateMenuDto,
  UpdateMenuDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  AddItemToCategoryDto,
  ReorderDto,
} from "./dto/menu.dto";

const MENU_INCLUDE = {
  categories: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      items: {
        orderBy: { sortOrder: "asc" as const },
        include: {
          item: {
            include: {
              modifierGroupLinks: {
                include: { group: { include: { options: { orderBy: { sortOrder: "asc" as const } } } } },
                orderBy: { sortOrder: "asc" as const },
              },
              variants: { orderBy: { sortOrder: "asc" as const } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.MenuInclude;

@Injectable()
export class MenusService {
  private readonly logger = new Logger(MenusService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.MENU_SYNC) private readonly menuSyncQueue: Queue,
    private readonly plu: PluService,
  ) {}

  // ── Menu CRUD ─────────────────────────────────────────────────────────────

  async findAllByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menu.findMany({
      where: { brandId, deletedAt: null },
      include: {
        _count: { select: { categories: true, versions: true } },
        versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, label: true, createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Phase AP — list menus that belong to a specific LOCATION only.
   *
   * Operators were seeing menus from sibling locations because the menu
   * list page filtered by brandId; in a multi-location franchise that
   * brand owns several locations and their menus all rolled up. The
   * Menu tab now scopes strictly to the location currently selected
   * in the location selector, so each location only sees its own menus.
   *
   * We include menus whose Menu.locationId matches the requested
   * location. Legacy brand-only menus (Menu.locationId null) are
   * deliberately NOT included — they belong to no location in the
   * Phase AP model. Operators with one such menu can migrate it via
   * the existing update endpoint (set locationId on the menu).
   */
  async findAllByLocation(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    return this.prisma.menu.findMany({
      where: { locationId, deletedAt: null },
      include: {
        _count: { select: { categories: true, versions: true } },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, label: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
      include: MENU_INCLUDE,
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  async create(brandId: string, tenantId: string, dto: CreateMenuDto) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menu.create({
      data: {
        brandId,
        name: dto.name,
        description: dto.description,
        status: "DRAFT",
        // Phase AM — Deliverect-style create form ships these. All
        // optional on the schema; only sent when the operator filled
        // them in.
        ...(dto.menuType && { menuType: dto.menuType as any }),
        ...(dto.bannerImage !== undefined && { bannerImage: dto.bannerImage }),
        ...(dto.logoImage !== undefined && { logoImage: dto.logoImage }),
        ...(dto.heroImage !== undefined && { heroImage: dto.heroImage }),
        ...(dto.locationId && { locationId: dto.locationId }),
      },
    });
  }

  async update(menuId: string, tenantId: string, dto: UpdateMenuDto) {
    await this.assertMenuAccess(menuId, tenantId);
    // Phase AW — verify the destination brand belongs to the caller
    // before we let the publish picker re-home the menu. Without this
    // a stale brandId in the picker could move the menu under a sibling
    // tenant's brand.
    if (dto.brandId) await this.assertBrandAccess(dto.brandId, tenantId);
    return this.prisma.menu.update({
      where: { id: menuId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status && { status: dto.status as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.menuType && { menuType: dto.menuType as any }),
        ...(dto.bannerImage !== undefined && { bannerImage: dto.bannerImage }),
        ...(dto.logoImage !== undefined && { logoImage: dto.logoImage }),
        ...(dto.heroImage !== undefined && { heroImage: dto.heroImage }),
        ...(dto.locationId !== undefined && { locationId: dto.locationId }),
        ...(dto.brandId && { brandId: dto.brandId }),
        // Phase AM — publish target picker writes its selection here.
        // Stamping lastPublishedAt only when at least one target is on
        // means an "unpublish-all" leaves the previous stamp intact for
        // audit trail purposes.
        ...(dto.publishedTo !== undefined && {
          publishedTo: dto.publishedTo,
          ...(dto.publishedTo.length > 0 && {
            lastPublishedAt: new Date(),
          }),
        }),
      },
    });
  }

  async publish(menuId: string, tenantId: string, userId?: string) {
    const menu = await this.assertMenuAccess(menuId, tenantId);

    // Snapshot for versioning
    const fullMenu = await this.findOne(menuId, tenantId);
    const lastVersion = await this.prisma.menuVersion.findFirst({
      where: { menuId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await this.prisma.$transaction([
      this.prisma.menu.update({
        where: { id: menuId },
        data: { status: "PUBLISHED", isActive: true },
      }),
      this.prisma.menuVersion.create({
        data: {
          menuId,
          version: (lastVersion?.version ?? 0) + 1,
          snapshot: fullMenu as any,
          label: `Published ${new Date().toISOString().split("T")[0]}`,
          createdBy: userId ?? null,
        },
      }),
    ]);

    await this.menuSyncQueue.add(
      MENU_JOBS.PUSH_TO_PLATFORM,
      { menuId, brandId: menu.brandId, tenantId },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        jobId: `menu-push-${menuId}-${Date.now()}`,
      },
    );

    return this.prisma.menu.findUnique({ where: { id: menuId } });
  }

  async archive(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    return this.prisma.menu.update({
      where: { id: menuId },
      data: { status: "ARCHIVED", isActive: false },
    });
  }

  async remove(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    await this.prisma.menu.update({
      where: { id: menuId },
      data: { deletedAt: new Date() },
    });
  }

  async clone(menuId: string, tenantId: string, name: string) {
    const source = await this.findOne(menuId, tenantId);

    return this.prisma.$transaction(async (tx) => {
      const cloned = await tx.menu.create({
        data: { brandId: source.brandId, name, status: "DRAFT" },
      });

      for (const cat of source.categories) {
        const newCat = await tx.menuCategory.create({
          data: {
            menuId: cloned.id,
            name: cat.name,
            description: (cat as any).description ?? null,
            sortOrder: cat.sortOrder,
          },
        });
        for (const link of cat.items) {
          await tx.menuItemOnCategory.create({
            data: {
              categoryId: newCat.id,
              itemId: link.itemId,
              sortOrder: link.sortOrder,
              priceOverride: link.priceOverride,
            },
          });
        }
      }

      return cloned;
    });
  }

  // ── Menu Versioning ────────────────────────────────────────────────────────

  async getVersions(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    return this.prisma.menuVersion.findMany({
      where: { menuId },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, label: true, createdBy: true, createdAt: true,
      },
    });
  }

  async rollback(menuId: string, versionId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);

    const version = await this.prisma.menuVersion.findFirst({
      where: { id: versionId, menuId },
    });
    if (!version) throw new NotFoundException("Version not found");

    // Restore: delete all current categories, recreate from snapshot
    const snapshot = version.snapshot as any;

    await this.prisma.$transaction(async (tx) => {
      await tx.menuCategory.deleteMany({ where: { menuId } });

      for (const cat of snapshot.categories ?? []) {
        const newCat = await tx.menuCategory.create({
          data: {
            menuId,
            name: cat.name,
            description: cat.description ?? null,
            sortOrder: cat.sortOrder,
          },
        });
        for (const link of cat.items ?? []) {
          const item = link.item;
          // Ensure item still exists
          const exists = await tx.menuItem.findUnique({ where: { id: item.id } });
          if (exists) {
            await tx.menuItemOnCategory.create({
              data: {
                categoryId: newCat.id,
                itemId: item.id,
                sortOrder: link.sortOrder,
                priceOverride: link.priceOverride,
              },
            }).catch(() => {});  // ignore if already linked
          }
        }
      }

      await tx.menu.update({
        where: { id: menuId },
        data: { status: "DRAFT" },
      });
    });

    this.logger.log(`Menu ${menuId} rolled back to version ${version.version}`);
    return this.findOne(menuId, tenantId);
  }

  // ── Category CRUD ─────────────────────────────────────────────────────────

  async createCategory(menuId: string, tenantId: string, dto: CreateCategoryDto) {
    await this.assertMenuAccess(menuId, tenantId);
    const maxOrder = await this.prisma.menuCategory.aggregate({
      where: { menuId },
      _max: { sortOrder: true },
    });
    return this.prisma.menuCategory.create({
      data: {
        menuId,
        name: dto.name,
        description: (dto as any).description ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async updateCategory(categoryId: string, tenantId: string, dto: UpdateCategoryDto) {
    await this.assertCategoryAccess(categoryId, tenantId);
    return this.prisma.menuCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...((dto as any).description !== undefined && { description: (dto as any).description }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...((dto as any).isActive !== undefined && { isVisible: (dto as any).isActive }),
      },
    });
  }

  async removeCategory(categoryId: string, tenantId: string) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.menuCategory.delete({ where: { id: categoryId } });
  }

  async reorderCategories(menuId: string, tenantId: string, dto: ReorderDto) {
    await this.assertMenuAccess(menuId, tenantId);
    // ReorderDto carries `items: [{id, sortOrder}]` — earlier code read
    // `dto.order` which doesn't exist on the DTO, so every drag-drop
    // request silently no-op'd. The categories list looked like it had
    // shuffled in the UI but the next page-load reset to the old order.
    const items =
      (dto as any).items ?? (dto as any).order ?? [];
    if (items.length === 0) return;
    await this.prisma.$transaction(
      items.map(
        ({ id, sortOrder }: { id: string; sortOrder: number }) =>
          this.prisma.menuCategory.update({
            where: { id },
            data: { sortOrder },
          }),
      ),
    );
  }

  // ── MenuItem CRUD ─────────────────────────────────────────────────────────

  async findItemsByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menuItem.findMany({
      where: { brandId },
      include: {
        modifierGroupLinks: {
          include: { group: { include: { options: true } } },
        },
        variants: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Phase AP — list catalog items scoped strictly to a location.
   *
   * Operators reported sibling locations seeing each other's products
   * because the Products tab was filtering by brandId. This mirrors
   * the Menu tab change: each shop only sees its own catalog. Items
   * with locationId=null are intentionally NOT included — those are
   * legacy brand-only rows the operator can re-assign from the UI.
   */
  async findItemsByLocation(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.menuItem.findMany({
      where: { locationId },
      include: {
        modifierGroupLinks: {
          include: { group: { include: { options: true } } },
        },
        variants: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });
  }

  async createItem(brandId: string, tenantId: string, dto: CreateMenuItemDto) {
    await this.assertBrandAccess(brandId, tenantId);
    // Phase AK: auto-generate PLU if the caller didn't supply one. This
    // mirrors Base44's `prod_${Date.now()}` default but uses our
    // collision-safe generator. Operator can override via dto.plu.
    const explicitPlu = ((dto as any).plu as string | undefined)?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("product", tenantId));

    return this.prisma.menuItem.create({
      data: {
        brandId,
        // Phase AP — stamp the product onto a specific location when the
        // caller (Products tab) provides one. Without it the row stays
        // brand-only and shows up nowhere on the new location-scoped UI.
        ...((dto as any).locationId && { locationId: (dto as any).locationId }),
        name: dto.name,
        description: dto.description,
        basePrice: dto.basePrice,
        imageUrl: dto.imageUrl,
        sku: dto.sku,
        plu,
        calories: dto.calories,
        allergens: dto.allergens ?? [],
        dietaryTags: (dto as any).dietaryTags ?? [],
        prepTime: (dto as any).prepTime ?? null,
        isInventoryTracked: (dto as any).isInventoryTracked ?? false,
        inventoryCount: (dto as any).inventoryCount ?? null,
        platformPricingOverrides: (dto as any).platformPricingOverrides ?? {},
        // Phase AK fields — all optional, sensible defaults from schema:
        visibleToCustomers: (dto as any).visibleToCustomers ?? true,
        outOfStock: (dto as any).outOfStock ?? false,
        hasMultipleSkus: (dto as any).hasMultipleSkus ?? false,
        productSkus: ((dto as any).productSkus ?? []) as any,
        deliveryTax: (dto as any).deliveryTax ?? 0,
        takeawayTax: (dto as any).takeawayTax ?? 0,
        eatInTax: (dto as any).eatInTax ?? 0,
        dietary: ((dto as any).dietary ?? []) as any,
        menuIds: ((dto as any).menuIds ?? []) as any,
      },
      include: {
        variants: true,
        modifierGroupLinks: { include: { group: { include: { options: true } } } },
      },
    });
  }

  async updateItem(itemId: string, tenantId: string, dto: UpdateMenuItemDto) {
    await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.basePrice !== undefined && { basePrice: dto.basePrice }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.calories !== undefined && { calories: dto.calories }),
        ...(dto.allergens !== undefined && { allergens: dto.allergens }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
        // Phase AL — Base44 catalog fields. All optional; whitelisted on
        // the DTO so the global ValidationPipe lets them through.
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.outOfStock !== undefined && { outOfStock: dto.outOfStock }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.hasMultipleSkus !== undefined && {
          hasMultipleSkus: dto.hasMultipleSkus,
        }),
        ...(dto.productSkus !== undefined && {
          productSkus: dto.productSkus as any,
        }),
        ...(dto.deliveryTax !== undefined && { deliveryTax: dto.deliveryTax }),
        ...(dto.takeawayTax !== undefined && { takeawayTax: dto.takeawayTax }),
        ...(dto.eatInTax !== undefined && { eatInTax: dto.eatInTax }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
        ...(dto.brandIds !== undefined && { brandIds: dto.brandIds }),
        ...(dto.dietaryTags !== undefined && { dietaryTags: dto.dietaryTags }),
        ...((dto as any).prepTime !== undefined && { prepTime: (dto as any).prepTime }),
        ...((dto as any).isInventoryTracked !== undefined && { isInventoryTracked: (dto as any).isInventoryTracked }),
        ...((dto as any).inventoryCount !== undefined && { inventoryCount: (dto as any).inventoryCount }),
        ...(dto.platformPricingOverrides !== undefined && {
          platformPricingOverrides: dto.platformPricingOverrides,
        }),
      },
      include: {
        variants: true,
        modifierGroupLinks: { include: { group: { include: { options: true } } } },
      },
    });
  }

  async toggleAvailability(itemId: string, tenantId: string) {
    const item = await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: { isAvailable: !item.isAvailable },
    });
  }

  async removeItem(itemId: string, tenantId: string) {
    await this.assertItemAccess(itemId, tenantId);
    await this.prisma.menuItem.delete({ where: { id: itemId } });
  }

  // ── Bulk Operations ────────────────────────────────────────────────────────

  async bulkToggleAvailability(itemIds: string[], tenantId: string, isAvailable: boolean) {
    // Validate all items belong to tenant — MenuItem has brandId but no Prisma Brand relation
    const tenantBrands = await this.prisma.brand.findMany({ where: { tenantId }, select: { id: true } });
    const brandIds = tenantBrands.map((b) => b.id);
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds }, brandId: { in: brandIds } },
      select: { id: true },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException("Some items not found or not accessible");
    }
    return this.prisma.menuItem.updateMany({
      where: { id: { in: itemIds } },
      data: { isAvailable },
    });
  }

  async bulkUpdatePrice(
    itemIds: string[],
    tenantId: string,
    adjustment: { type: "fixed" | "percentage"; value: number },
  ) {
    const tenantBrands2 = await this.prisma.brand.findMany({ where: { tenantId }, select: { id: true } });
    const brandIds2 = tenantBrands2.map((b) => b.id);
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds }, brandId: { in: brandIds2 } },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException("Some items not found");
    }

    await this.prisma.$transaction(
      items.map((item) => {
        const currentPrice = Number(item.basePrice);
        const newPrice =
          adjustment.type === "fixed"
            ? currentPrice + adjustment.value
            : currentPrice * (1 + adjustment.value / 100);
        return this.prisma.menuItem.update({
          where: { id: item.id },
          data: { basePrice: Math.max(0, Math.round(newPrice * 100) / 100) },
        });
      }),
    );

    return { updated: items.length };
  }

  // ── Item Variants ──────────────────────────────────────────────────────────

  async createVariant(
    itemId: string,
    tenantId: string,
    dto: { name: string; price: number; sku?: string; sortOrder?: number },
  ) {
    await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItemVariant.create({
      data: {
        itemId,
        name: dto.name,
        price: dto.price,
        sku: dto.sku ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateVariant(
    variantId: string,
    tenantId: string,
    dto: { name?: string; price?: number; sku?: string; sortOrder?: number; isAvailable?: boolean },
  ) {
    // MenuItem has no Brand relation; verify item ownership via brandId
    const variant = await this.prisma.menuItemVariant.findFirst({
      where: { id: variantId },
      include: { item: { select: { brandId: true } } },
    });
    if (!variant) throw new NotFoundException("Variant not found");
    const itemBrand = await this.prisma.brand.findFirst({ where: { id: variant.item.brandId, tenantId } });
    if (!itemBrand) throw new NotFoundException("Variant not found");
    return this.prisma.menuItemVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
      },
    });
  }

  async removeVariant(variantId: string, tenantId: string) {
    const variantToDelete = await this.prisma.menuItemVariant.findFirst({
      where: { id: variantId },
      include: { item: { select: { brandId: true } } },
    });
    if (!variantToDelete) throw new NotFoundException("Variant not found");
    const variantBrand = await this.prisma.brand.findFirst({ where: { id: variantToDelete.item.brandId, tenantId } });
    if (!variantBrand) throw new NotFoundException("Variant not found");
    await this.prisma.menuItemVariant.delete({ where: { id: variantId } });
  }

  // ── Modifier Groups ────────────────────────────────────────────────────────

  /**
   * Phase AP — list modifier groups scoped strictly to a location.
   * Same rationale as findItemsByLocation.
   */
  async findModifierGroupsByLocation(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.modifierGroup.findMany({
      where: { locationId },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
      orderBy: { name: "asc" },
    });
  }

  async findModifierGroupsByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    const groups = await this.prisma.modifierGroup.findMany({
      where: { brandId },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
      orderBy: { name: "asc" },
    });

    // Phase AL: also surface modifiers that are attached to a group via
    // the modifierGroupIds[] many-to-many array (not their FK primary
    // group). A modifier attached to group G via the array shows up in
    // G.options here alongside FK-matched ones, ordered by sortOrder.
    if (groups.length === 0) return groups;
    const groupIds = groups.map((g) => g.id);
    const arrayMatched = await this.prisma.modifierOption.findMany({
      where: {
        group: { brandId },
        modifierGroupIds: { hasSome: groupIds },
      },
      orderBy: { sortOrder: "asc" },
    });

    if (arrayMatched.length === 0) return groups;

    // Bucket by every groupId in modifierGroupIds[] so a modifier
    // attached to two groups shows under both.
    const extras = new Map<string, typeof arrayMatched>();
    for (const opt of arrayMatched) {
      for (const gId of opt.modifierGroupIds ?? []) {
        if (!groupIds.includes(gId)) continue;
        if (!extras.has(gId)) extras.set(gId, []);
        extras.get(gId)!.push(opt);
      }
    }

    return groups.map((g) => {
      const extra = extras.get(g.id) ?? [];
      if (extra.length === 0) return g;
      // De-dupe in case a modifier is both FK-primary AND array-listed
      // under the same group.
      const seen = new Set(g.options.map((o) => o.id));
      const merged = [
        ...g.options,
        ...extra.filter((o) => !seen.has(o.id)),
      ];
      return { ...g, options: merged };
    });
  }

  async createModifierGroup(
    brandId: string,
    tenantId: string,
    dto: {
      name: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number;
      isRequired?: boolean;
      selectionType?: "VARIANT" | "ADDON";
      allowDuplicateSelections?: boolean;
      plu?: string;
      menuIds?: string[];
      // Phase AP — Products section is location-scoped.
      locationId?: string;
    },
  ) {
    await this.assertBrandAccess(brandId, tenantId);
    const explicitPlu = dto.plu?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("modifierGroup", tenantId));
    return this.prisma.modifierGroup.create({
      data: {
        brandId,
        ...(dto.locationId && { locationId: dto.locationId }),
        name: dto.name,
        description: dto.description ?? null,
        plu,
        minSelections: dto.minSelections ?? 0,
        maxSelections: dto.maxSelections ?? null,
        isRequired: dto.isRequired ?? false,
        selectionType: dto.selectionType ?? "VARIANT",
        allowDuplicateSelections: dto.allowDuplicateSelections ?? false,
        menuIds: dto.menuIds ?? [],
      },
      include: { options: true },
    });
  }

  async updateModifierGroup(
    groupId: string,
    tenantId: string,
    dto: {
      name?: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number | null;
      isRequired?: boolean;
      selectionType?: "VARIANT" | "ADDON";
      allowDuplicateSelections?: boolean;
      plu?: string;
      visibleToCustomers?: boolean;
      menuIds?: string[];
    },
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    return this.prisma.modifierGroup.update({
      where: { id: groupId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.minSelections !== undefined && { minSelections: dto.minSelections }),
        ...(dto.maxSelections !== undefined && { maxSelections: dto.maxSelections }),
        ...(dto.isRequired !== undefined && { isRequired: dto.isRequired }),
        // Phase AL fields.
        ...(dto.selectionType !== undefined && { selectionType: dto.selectionType }),
        ...(dto.allowDuplicateSelections !== undefined && {
          allowDuplicateSelections: dto.allowDuplicateSelections,
        }),
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
      },
      include: { options: true },
    });
  }

  async removeModifierGroup(groupId: string, tenantId: string) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    await this.prisma.modifierGroup.delete({ where: { id: groupId } });
  }

  // ── Many-to-many: ModifierOption ↔ ModifierGroup ─────────────────────────
  //
  // Phase AL: same modifier (e.g. "Extra cheese") can belong to many
  // groups. Schema keeps `groupId` as a single FK for the "primary"
  // group (legacy + sort order) and a `modifierGroupIds[]` array for
  // additional memberships. Attach/detach operates on the array; the
  // primary FK never changes here.
  async attachModifierToGroup(
    groupId: string,
    optionId: string,
    tenantId: string,
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Modifier not found");
    const next = Array.from(
      new Set([...(option.modifierGroupIds ?? []), groupId]),
    );
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: { modifierGroupIds: next },
    });
  }

  async detachModifierFromGroup(
    groupId: string,
    optionId: string,
    tenantId: string,
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Modifier not found");
    // If this is the modifier's primary group, refuse to detach via
    // this path — the operator must move it to a different group first
    // (or delete it). Detaching only operates on the auxiliary array.
    if (option.groupId === groupId) {
      throw new BadRequestException(
        "This is the modifier's primary group. Move or delete the modifier instead.",
      );
    }
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: {
        modifierGroupIds: (option.modifierGroupIds ?? []).filter(
          (id) => id !== groupId,
        ),
      },
    });
  }

  async addModifierOption(
    groupId: string,
    tenantId: string,
    dto: {
      name: string;
      priceAdjustment?: number;
      isDefault?: boolean;
      imageUrl?: string;
      allergens?: string[];
      nestedGroupId?: string;
      plu?: string;
      pricesBySize?: Record<string, number>;
      skuPlus?: Record<string, string>;
      menuIds?: string[];
    },
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const maxOrder = await this.prisma.modifierOption.aggregate({
      where: { groupId },
      _max: { sortOrder: true },
    });
    const explicitPlu = dto.plu?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("modifier", tenantId));
    return this.prisma.modifierOption.create({
      data: {
        groupId,
        name: dto.name,
        plu,
        priceAdjustment: dto.priceAdjustment ?? 0,
        pricesBySize: (dto.pricesBySize ?? {}) as any,
        skuPlus: (dto.skuPlus ?? {}) as any,
        isDefault: dto.isDefault ?? false,
        imageUrl: dto.imageUrl ?? null,
        allergens: dto.allergens ?? [],
        nestedGroupId: dto.nestedGroupId ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        menuIds: dto.menuIds ?? [],
      },
    });
  }

  async updateModifierOption(
    optionId: string,
    tenantId: string,
    dto: {
      name?: string;
      priceAdjustment?: number;
      isDefault?: boolean;
      isAvailable?: boolean;
      imageUrl?: string;
      allergens?: string[];
      nestedGroupId?: string | null;
      sortOrder?: number;
      // Phase AL fields.
      plu?: string;
      pricesBySize?: Record<string, number>;
      skuPlus?: Record<string, string>;
      visibleToCustomers?: boolean;
      deliveryTax?: number;
      takeawayTax?: number;
      eatInTax?: number;
      menuIds?: string[];
    },
  ) {
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Option not found");
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.priceAdjustment !== undefined && { priceAdjustment: dto.priceAdjustment }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.allergens !== undefined && { allergens: dto.allergens }),
        ...(dto.nestedGroupId !== undefined && { nestedGroupId: dto.nestedGroupId }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        // Phase AL fields.
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.pricesBySize !== undefined && {
          pricesBySize: dto.pricesBySize as any,
        }),
        ...(dto.skuPlus !== undefined && { skuPlus: dto.skuPlus as any }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.deliveryTax !== undefined && { deliveryTax: dto.deliveryTax }),
        ...(dto.takeawayTax !== undefined && { takeawayTax: dto.takeawayTax }),
        ...(dto.eatInTax !== undefined && { eatInTax: dto.eatInTax }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
      },
    });
  }

  async removeModifierOption(optionId: string, tenantId: string) {
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Option not found");
    await this.prisma.modifierOption.delete({ where: { id: optionId } });
  }

  async linkModifierGroupToItem(itemId: string, groupId: string, tenantId: string, sortOrder = 0) {
    await this.assertItemAccess(itemId, tenantId);
    await this.assertModifierGroupAccess(groupId, tenantId);
    try {
      return await this.prisma.modifierGroupOnItem.create({
        data: { itemId, groupId, sortOrder },
        include: { group: { include: { options: true } } },
      });
    } catch {
      throw new ConflictException("Modifier group already linked to this item");
    }
  }

  async unlinkModifierGroupFromItem(itemId: string, groupId: string, tenantId: string) {
    await this.assertItemAccess(itemId, tenantId);
    await this.prisma.modifierGroupOnItem.delete({
      where: { itemId_groupId: { itemId, groupId } },
    });
  }

  // ── Category ↔ Item links ────────────────────────────────────────────────

  async addItemToCategory(categoryId: string, tenantId: string, dto: AddItemToCategoryDto) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.assertItemAccess(dto.itemId, tenantId);
    try {
      return await this.prisma.menuItemOnCategory.create({
        data: {
          categoryId,
          itemId: dto.itemId,
          sortOrder: dto.sortOrder ?? 0,
          priceOverride: dto.priceOverride,
        },
        include: { item: true },
      });
    } catch {
      throw new ConflictException("Item already in this category");
    }
  }

  async removeItemFromCategory(categoryId: string, itemId: string, tenantId: string) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.menuItemOnCategory.delete({
      where: { categoryId_itemId: { categoryId, itemId } },
    });
  }

  async reorderItemsInCategory(categoryId: string, tenantId: string, order: Array<{ itemId: string; sortOrder: number }>) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.$transaction(
      order.map(({ itemId, sortOrder }) =>
        this.prisma.menuItemOnCategory.update({
          where: { categoryId_itemId: { categoryId, itemId } },
          data: { sortOrder },
        }),
      ),
    );
  }

  // ── Location-scoped active menu (POS + storefront) ────────────────────────
  //
  // Phase AP — POS only shows a menu when it's been EXPLICITLY published
  // to this location for the POS target. No brand-scoped fallback, no
  // implicit "isActive=true is enough" — until the operator opens the
  // publish modal and ticks "Order Hub POS", the till stays empty.
  //
  // The publish flow stores selected targets in Menu.publishedTo[] and
  // also flips Menu.status to PUBLISHED. We require BOTH:
  //   • status = PUBLISHED         (so a draft can't accidentally show)
  //   • publishedTo contains "POS" (so the operator's intent is explicit)
  //   • locationId = this location (so sibling sites don't leak)
  //
  // Returns a "full menu" structure shaped for POS consumption: every
  // category, every visible item, modifier groups + options, productSkus.
  async findActiveMenuForLocation(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    const menu = await this.prisma.menu.findFirst({
      where: {
        locationId,
        status: "PUBLISHED",
        deletedAt: null,
        publishedTo: { has: "POS" },
      },
      // Most recently published wins when an operator has multiple
      // POS-targeted menus active on a single location.
      orderBy: [{ lastPublishedAt: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    });
    if (!menu) return null;

    return this.findOne(menu.id, tenantId);
  }

  // ── Public menu (for online ordering) ────────────────────────────────────

  async findPublishedByBrand(brandId: string) {
    return this.prisma.menu.findFirst({
      where: { brandId, status: "PUBLISHED", deletedAt: null, isActive: true },
      include: {
        categories: {
          where: { isVisible: true },
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { isVisible: true, item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: {
                        group: {
                          include: {
                            options: {
                              where: { isAvailable: true },
                              orderBy: { sortOrder: "asc" },
                            },
                          },
                        },
                      },
                      orderBy: { sortOrder: "asc" },
                    },
                    variants: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  // ── Access guards ──────────────────────────────────────────────────────────

  private async assertBrandAccess(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  /** Phase AP — used by every location-scoped endpoint
   *  (findAllByLocation, findItemsByLocation, findModifierGroupsByLocation). */
  private async assertLocationAccess(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

  private async assertMenuAccess(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  private async assertCategoryAccess(categoryId: string, tenantId: string) {
    const cat = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, menu: { brand: { tenantId } } },
    });
    if (!cat) throw new NotFoundException("Category not found");
    return cat;
  }

  private async assertItemAccess(itemId: string, tenantId: string) {
    // MenuItem has brandId (FK) but no Prisma relation to Brand; verify via join
    const item = await this.prisma.menuItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Menu item not found");
    const brand = await this.prisma.brand.findFirst({ where: { id: item.brandId, tenantId } });
    if (!brand) throw new NotFoundException("Menu item not found");
    return item;
  }

  private async assertModifierGroupAccess(groupId: string, tenantId: string) {
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, brand: { tenantId } },
    });
    if (!group) throw new NotFoundException("Modifier group not found");
    return group;
  }
}
