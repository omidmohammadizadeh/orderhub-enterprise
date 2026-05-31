import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AN — Brand CRUD, extended with description/cuisine/logoUrl/
// isSuspended/primaryLocationId. A brand can be tenant-wide (the franchise
// case — Location.brandId points back) or scoped to a single location
// (the "virtual brand" / ghost-kitchen case — primaryLocationId is set).

export interface CreateBrandDto {
  name: string;
  slug?: string;
  description?: string;
  cuisine?: string;
  logoUrl?: string;
  primaryLocationId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateBrandDto {
  name?: string;
  description?: string | null;
  cuisine?: string | null;
  logoUrl?: string | null;
  isSuspended?: boolean;
  isActive?: boolean;
  primaryLocationId?: string | null;
  metadata?: Record<string, unknown>;
}

function slugify(name: string): string {
  return (
    (name ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "brand"
  );
}

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  /** List brands for a tenant. When locationId is given, returns brands
   *  whose primaryLocationId === locationId (virtual brands at that
   *  location) PLUS the franchise brand the location belongs to. */
  async findAll(tenantId: string, locationId?: string) {
    if (!locationId) {
      return this.prisma.brand.findMany({
        where: { tenantId, deletedAt: null },
        include: { _count: { select: { locations: true, platformConnections: true } } },
        orderBy: { createdAt: "asc" },
      });
    }

    // Phase AN follow-up: brands listed at a location are STRICTLY scoped
    // to that location via primaryLocationId. We no longer leak the
    // tenant's default "Main" / franchise parent brand here — the
    // operator wants this list to be "brands that operate FROM this
    // physical kitchen" only.
    return this.prisma.brand.findMany({
      where: {
        tenantId,
        deletedAt: null,
        primaryLocationId: locationId,
      },
      include: { _count: { select: { platformConnections: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOne(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      include: {
        locations: { where: { deletedAt: null } },
        platformConnections: true,
      },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  async create(tenantId: string, dto: CreateBrandDto) {
    const slug = dto.slug ?? slugify(dto.name);
    const existing = await this.prisma.brand.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException("Brand slug already in use");
    }

    return this.prisma.brand.create({
      data: {
        tenantId,
        name: dto.name,
        slug,
        description: dto.description ?? null,
        cuisine: dto.cuisine ?? null,
        logoUrl: dto.logoUrl ?? null,
        primaryLocationId: dto.primaryLocationId ?? null,
        metadata: (dto.metadata ?? {}) as any,
      },
    });
  }

  async update(brandId: string, tenantId: string, dto: UpdateBrandDto) {
    await this.assertAccess(brandId, tenantId);
    return this.prisma.brand.update({
      where: { id: brandId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.cuisine !== undefined && { cuisine: dto.cuisine }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.isSuspended !== undefined && { isSuspended: dto.isSuspended }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.primaryLocationId !== undefined && {
          primaryLocationId: dto.primaryLocationId,
        }),
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
