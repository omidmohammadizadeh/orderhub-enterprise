import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AL — Catalog service.
//
// Owns the "master catalog" extras that aren't already handled by the
// MenusService: MealDeals and UpsellGroups. Standard CRUD plus the same
// tenant-scoping guard pattern used elsewhere (verify brand belongs to
// tenant before any mutation).

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Meal Deals ─────────────────────────────────────────────────────────
  async listMealDeals(brandId: string, tenantId: string) {
    await this.assertBrand(brandId, tenantId);
    return this.prisma.mealDeal.findMany({
      where: { brandId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createMealDeal(brandId: string, tenantId: string, data: any) {
    await this.assertBrand(brandId, tenantId);
    if (!data?.name?.trim()) {
      throw new BadRequestException("Name is required");
    }
    return this.prisma.mealDeal.create({
      data: {
        brandId,
        name: String(data.name).trim(),
        description: data.description ?? null,
        imageUrl: data.imageUrl ?? null,
        plu: data.plu ?? null,
        price: data.price ?? null,
        sections: data.sections ?? [],
        deliveryTax: data.deliveryTax ?? 0,
        takeawayTax: data.takeawayTax ?? 0,
        eatInTax: data.eatInTax ?? 0,
        platformPricingOverrides: data.platformPricingOverrides ?? {},
        isAvailable: data.isAvailable ?? true,
        visibleToCustomers: data.visibleToCustomers ?? true,
        locationIds: data.locationIds ?? [],
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  async updateMealDeal(id: string, tenantId: string, data: any) {
    const existing = await this.prisma.mealDeal.findFirst({
      where: { id, brand: { tenantId } },
    });
    if (!existing) throw new NotFoundException("Meal deal not found");
    return this.prisma.mealDeal.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: String(data.name).trim() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.plu !== undefined && { plu: data.plu }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.sections !== undefined && { sections: data.sections }),
        ...(data.deliveryTax !== undefined && { deliveryTax: data.deliveryTax }),
        ...(data.takeawayTax !== undefined && { takeawayTax: data.takeawayTax }),
        ...(data.eatInTax !== undefined && { eatInTax: data.eatInTax }),
        ...(data.platformPricingOverrides !== undefined && {
          platformPricingOverrides: data.platformPricingOverrides,
        }),
        ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
        ...(data.visibleToCustomers !== undefined && {
          visibleToCustomers: data.visibleToCustomers,
        }),
        ...(data.locationIds !== undefined && { locationIds: data.locationIds }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
    });
  }

  async deleteMealDeal(id: string, tenantId: string) {
    const existing = await this.prisma.mealDeal.findFirst({
      where: { id, brand: { tenantId } },
    });
    if (!existing) throw new NotFoundException("Meal deal not found");
    await this.prisma.mealDeal.delete({ where: { id } });
  }

  // ── Upsell Groups ──────────────────────────────────────────────────────
  async listUpsellGroups(brandId: string, tenantId: string) {
    await this.assertBrand(brandId, tenantId);
    return this.prisma.upsellGroup.findMany({
      where: { brandId },
      orderBy: { sortOrder: "asc" },
    });
  }

  async createUpsellGroup(brandId: string, tenantId: string, data: any) {
    await this.assertBrand(brandId, tenantId);
    if (!data?.name?.trim()) {
      throw new BadRequestException("Name is required");
    }
    return this.prisma.upsellGroup.create({
      data: {
        brandId,
        name: String(data.name).trim(),
        description: data.description ?? null,
        triggerProductIds: data.triggerProductIds ?? [],
        triggerCategoryIds: data.triggerCategoryIds ?? [],
        suggestedProductIds: data.suggestedProductIds ?? [],
        sortOrder: data.sortOrder ?? 0,
        platformVisibility: data.platformVisibility ?? [],
        isActive: data.isActive ?? true,
      },
    });
  }

  async updateUpsellGroup(id: string, tenantId: string, data: any) {
    const existing = await this.prisma.upsellGroup.findFirst({
      where: { id, brand: { tenantId } },
    });
    if (!existing) throw new NotFoundException("Upsell group not found");
    return this.prisma.upsellGroup.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: String(data.name).trim() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.triggerProductIds !== undefined && {
          triggerProductIds: data.triggerProductIds,
        }),
        ...(data.triggerCategoryIds !== undefined && {
          triggerCategoryIds: data.triggerCategoryIds,
        }),
        ...(data.suggestedProductIds !== undefined && {
          suggestedProductIds: data.suggestedProductIds,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.platformVisibility !== undefined && {
          platformVisibility: data.platformVisibility,
        }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  }

  async deleteUpsellGroup(id: string, tenantId: string) {
    const existing = await this.prisma.upsellGroup.findFirst({
      where: { id, brand: { tenantId } },
    });
    if (!existing) throw new NotFoundException("Upsell group not found");
    await this.prisma.upsellGroup.delete({ where: { id } });
  }

  // ── Tenant guard ──────────────────────────────────────────────────────
  private async assertBrand(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }
}
