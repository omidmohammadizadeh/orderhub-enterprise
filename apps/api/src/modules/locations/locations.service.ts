import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface CreateLocationDto {
  brandId: string;
  name: string;
  address: { line1: string; line2?: string; city: string; postcode: string; country?: string };
  phone?: string;
  timezone?: string;
  slug?: string;
}

export interface UpdateLocationDto {
  name?: string;
  address?: Record<string, string>;
  phone?: string;
  timezone?: string;
  isActive?: boolean;
  openingHours?: Array<{ day: number; open: string; close: string }>;
  deliveryConfig?: Record<string, unknown>;
  slug?: string;
  settings?: Record<string, unknown>;
}

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, brandId?: string) {
    return this.prisma.location.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId, ...(brandId && { id: brandId }) },
      },
      include: { brand: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });
  }

  async findOne(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      include: {
        brand: { select: { id: true, name: true } },
        integrations: { where: { deletedAt: null }, select: { platform: true, status: true } },
        printers: { where: { deletedAt: null } },
        kdsScreens: true,
      },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

  async create(tenantId: string, dto: CreateLocationDto) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: dto.brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    return this.prisma.location.create({
      data: {
        brandId: dto.brandId,
        name: dto.name,
        address: dto.address as any,
        phone: dto.phone,
        timezone: dto.timezone ?? "Europe/London",
        slug: dto.slug,
      },
    });
  }

  async update(locationId: string, tenantId: string, dto: UpdateLocationDto) {
    await this.assertAccess(locationId, tenantId);
    return this.prisma.location.update({
      where: { id: locationId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.address && { address: dto.address as any }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.timezone && { timezone: dto.timezone }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.openingHours !== undefined && { openingHours: dto.openingHours as any }),
        ...(dto.deliveryConfig !== undefined && { deliveryConfig: dto.deliveryConfig as any }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.settings !== undefined && { settings: dto.settings as any }),
      },
    });
  }

  async remove(locationId: string, tenantId: string) {
    await this.assertAccess(locationId, tenantId);
    await this.prisma.location.update({
      where: { id: locationId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async assertAccess(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }
}
