import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  ForbiddenException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
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
    where: { items: undefined },
    orderBy: { sortOrder: "asc" as const },
    include: {
      items: {
        orderBy: { sortOrder: "asc" as const },
        include: { item: true },
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
  ) {}

  // ── Menu CRUD ─────────────────────────────────────────────────────────────

  async findAllByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menu.findMany({
      where: { brandId, deletedAt: null },
      include: { _count: { select: { categories: true } } },
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

  async publish(menuId: string, tenantId: string) {
    const menu = await this.assertMenuAccess(menuId, tenantId);
    const updated = await this.prisma.menu.update({
      where: { id: menuId },
      data: { status: "PUBLISHED", isActive: true },
    });

    await this.menuSyncQueue.add(
      MENU_JOBS.PUSH_TO_PLATFORM,
      { menuId, brandId: menu.brandId, tenantId },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        jobId: `menu-push-${menuId}-${Date.now()}`,
      },
    );

    return updated;
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
          data: { menuId: cloned.id, name: cat.name, sortOrder: cat.sortOrder },
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

      return tx.menu.findUnique({ where: { id: cloned.id }, include: MENU_INCLUDE });
    });
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
        sortOrder: dto.sortOrder ?? (maxOrder._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async updateCategory(categoryId: string, tenantId: string, dto: UpdateCategoryDto) {
    await this.assertCategoryAccess(categoryId, tenantId);
    return this.prisma.menuCategory.update({
      where: { id: categoryId },
      data: dto,
    });
  }

  async removeCategory(categoryId: string, tenantId: string) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.menuCategory.delete({ where: { id: categoryId } });
  }

  async reorderCategories(menuId: string, tenantId: string, dto: ReorderDto) {
    await this.assertMenuAccess(menuId, tenantId);
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.menuCategory.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
  }

  // ── MenuItem CRUD ─────────────────────────────────────────────────────────

  async findItemsByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menuItem.findMany({
      where: { brandId },
      orderBy: { name: "asc" },
    });
  }

  async createItem(brandId: string, tenantId: string, dto: CreateMenuItemDto) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menuItem.create({
      data: {
        brandId,
        name: dto.name,
        description: dto.description,
        basePrice: dto.basePrice,
        imageUrl: dto.imageUrl,
        sku: dto.sku,
        calories: dto.calories,
        allergens: dto.allergens ?? [],
        modifierGroups: (dto.modifierGroups ?? []) as any,
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
        ...(dto.modifierGroups !== undefined && { modifierGroups: dto.modifierGroups as any }),
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

  // ── Category ↔ Item links ────────────────────────────────────────────────

  async addItemToCategory(
    categoryId: string,
    tenantId: string,
    dto: AddItemToCategoryDto,
  ) {
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

  // ── Public menu (for online ordering) ────────────────────────────────────

  async findPublishedByBrand(brandId: string) {
    return this.prisma.menu.findFirst({
      where: { brandId, status: "PUBLISHED", deletedAt: null, isActive: true },
      include: {
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: { item: true },
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
    const item = await this.prisma.menuItem.findFirst({
      where: { id: itemId, brand: { tenantId } },
    });
    if (!item) throw new NotFoundException("Menu item not found");
    return item;
  }
}
