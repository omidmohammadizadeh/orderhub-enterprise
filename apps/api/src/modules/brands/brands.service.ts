import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface CreateBrandDto {
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateBrandDto {
  name?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      include: { _count: { select: { locations: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOne(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      include: { locations: { where: { deletedAt: null } } },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  async create(tenantId: string, dto: CreateBrandDto) {
    const existing = await this.prisma.brand.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException("Brand slug already in use");
    }

    return this.prisma.brand.create({
      data: { tenantId, name: dto.name, slug: dto.slug, metadata: (dto.metadata ?? {}) as any },
    });
  }

  async update(brandId: string, tenantId: string, dto: UpdateBrandDto) {
    await this.assertAccess(brandId, tenantId);
    return this.prisma.brand.update({
      where: { id: brandId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.metadata && { metadata: dto.metadata as any }),
      },
    });
  }

  async remove(brandId: string, tenantId: string) {
    await this.assertAccess(brandId, tenantId);
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { deletedAt: new Date() },
    });
  }

  private async assertAccess(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }
}
