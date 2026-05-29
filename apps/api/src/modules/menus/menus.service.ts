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
      data: { brandId, name: dto.name, description: dto.description, status: "DRAFT" },
    });
  }

  async update(menuId: string, tenantId: string, dto: UpdateMenuDto) {
    await this.assertMenuAccess(menuId, tenantId);
    return this.prisma.menu.update({
      where: { id: menuId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status && { status: dto.status as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
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
    await this.prisma.$transaction(
      (dto as any).order.map(({ id, sortOrder }: { id: string; sortOrder: number }) =>
        this.prisma.menuCategory.update({ where: { id }, data: { sortOrder } }),
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
        ...((dto as any).dietaryTags !== undefined && { dietaryTags: (dto as any).dietaryTags }),
        ...((dto as any).prepTime !== undefined && { prepTime: (dto as any).prepTime }),
        ...((dto as any).isInventoryTracked !== undefined && { isInventoryTracked: (dto as any).isInventoryTracked }),
        ...((dto as any).inventoryCount !== undefined && { inventoryCount: (dto as any).inventoryCount }),
        ...((dto as any).platformPricingOverrides !== undefined && { platformPricingOverrides: (dto as any).platformPricingOverrides }),
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

  async findModifierGroupsByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.modifierGroup.findMany({
      where: { brandId },
      include: { options: { orderBy: { sortOrder: "asc" } }, _count: { select: { itemLinks: true } } },
      orderBy: { name: "asc" },
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
    },
  ) {
    await this.assertBrandAccess(brandId, tenantId);
    const explicitPlu = dto.plu?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("modifierGroup", tenantId));
    return this.prisma.modifierGroup.create({
      data: {
        brandId,
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
      },
      include: { options: true },
    });
  }

  async removeModifierGroup(groupId: string, tenantId: string) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    await this.prisma.modifierGroup.delete({ where: { id: groupId } });
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
  // Phase AK: Base44 menus belong to a location. Find the active menu for
  // the given location by checking the locationId column first; fall back
  // to the brand's active menu if the location-scoped query is empty
  // (covers brand-scoped pre-Phase-AK menus).
  //
  // Returns a "full menu" structure shaped for POS consumption: every
  // category, every visible item, modifier groups + options, productSkus.
  async findActiveMenuForLocation(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    // Prefer location-scoped active menu (Phase AK shape).
    let menu = await this.prisma.menu.findFirst({
      where: { locationId, isActive: true, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    // Fall back to brand-scoped active menu.
    if (!menu) {
      menu = await this.prisma.menu.findFirst({
        where: { brandId: location.brandId, isActive: true, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
    }
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
