import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AM — DeliveryZone CRUD + postcode lookup.
//
// Lookup strategy: normalise the inbound postcode (uppercase, strip
// whitespace) then progressively shorten it from the right and search for
// the longest matching `postcodePrefix` on this location. This means a
// merchant can configure both broad areas ("SW1") and specific outcodes
// ("SW1A") and the more specific one always wins.

export interface CreateDeliveryZoneDto {
  locationId?: string;
  brandId?: string;
  postcodePrefix: string;
  fee: number;
  minOrderValue?: number;
  isActive?: boolean;
}

export interface UpdateDeliveryZoneDto {
  postcodePrefix?: string;
  fee?: number;
  minOrderValue?: number | null;
  isActive?: boolean;
}

export interface LookupResult {
  matched: boolean;
  zoneId?: string;
  postcodePrefix?: string;
  fee: number;
  minOrderValue?: number | null;
}

export function normalisePostcode(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "");
}

@Injectable()
export class DeliveryZonesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  private async assertBrand(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
  }

  async listForLocation(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    return this.prisma.deliveryZone.findMany({
      where: { locationId },
      orderBy: [{ isActive: "desc" }, { postcodePrefix: "asc" }],
    });
  }

  async listForBrand(tenantId: string, brandId: string) {
    await this.assertBrand(tenantId, brandId);
    return this.prisma.deliveryZone.findMany({
      where: { brandId } as any,
      orderBy: [{ isActive: "desc" }, { postcodePrefix: "asc" }],
    });
  }

  async create(tenantId: string, dto: CreateDeliveryZoneDto) {
    const prefix = normalisePostcode(dto.postcodePrefix);
    if (!prefix) throw new BadRequestException("postcodePrefix is required");
    if (dto.fee < 0) throw new BadRequestException("fee must be ≥ 0");
    if (!dto.locationId && !dto.brandId) {
      throw new BadRequestException("locationId or brandId is required");
    }
    if (dto.locationId && dto.brandId) {
      throw new BadRequestException(
        "Provide either locationId or brandId, not both",
      );
    }
    if (dto.locationId) await this.assertLocation(tenantId, dto.locationId);
    if (dto.brandId) await this.assertBrand(tenantId, dto.brandId);

    return this.prisma.deliveryZone.create({
      data: {
        tenantId,
        locationId: dto.locationId ?? null,
        brandId: dto.brandId ?? null,
        postcodePrefix: prefix,
        fee: dto.fee,
        minOrderValue: dto.minOrderValue ?? null,
        isActive: dto.isActive ?? true,
      } as any,
    });
  }

  async update(tenantId: string, id: string, dto: UpdateDeliveryZoneDto) {
    const zone = await this.prisma.deliveryZone.findFirst({
      where: { id, tenantId },
    });
    if (!zone) throw new NotFoundException("Delivery zone not found");

    return this.prisma.deliveryZone.update({
      where: { id },
      data: {
        ...(dto.postcodePrefix !== undefined && {
          postcodePrefix: normalisePostcode(dto.postcodePrefix),
        }),
        ...(dto.fee !== undefined && { fee: dto.fee }),
        ...(dto.minOrderValue !== undefined && { minOrderValue: dto.minOrderValue }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const zone = await this.prisma.deliveryZone.findFirst({
      where: { id, tenantId },
    });
    if (!zone) throw new NotFoundException("Delivery zone not found");
    await this.prisma.deliveryZone.delete({ where: { id } });
  }

  /**
   * Look up the delivery fee for a given postcode at this location. Returns
   * { matched: false, fee: 0 } when no zone matches — the POS UI can decide
   * whether to fail-closed (refuse delivery) or fall back to a global fee.
   */
  async lookup(
    tenantId: string,
    locationId: string,
    postcode: string,
  ): Promise<LookupResult> {
    await this.assertLocation(tenantId, locationId);
    const normalised = normalisePostcode(postcode);
    if (!normalised) return { matched: false, fee: 0 };

    const zones = await this.prisma.deliveryZone.findMany({
      where: { locationId, isActive: true },
    });

    // Match the LONGEST prefix that the postcode starts with.
    let best: (typeof zones)[number] | null = null;
    for (const z of zones) {
      const zp = normalisePostcode(z.postcodePrefix);
      if (normalised.startsWith(zp)) {
        if (!best || zp.length > normalisePostcode(best.postcodePrefix).length) {
          best = z;
        }
      }
    }

    if (!best) return { matched: false, fee: 0 };

    return {
      matched: true,
      zoneId: best.id,
      postcodePrefix: best.postcodePrefix,
      fee: Number(best.fee),
      minOrderValue: best.minOrderValue !== null ? Number(best.minOrderValue) : null,
    };
  }
}
