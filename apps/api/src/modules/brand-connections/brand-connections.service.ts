import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AN — Brand × Location × Platform connection foundation.
//
// One row per (brand, location, platform). For now these are
// placeholders the UI renders — the real OAuth / API connection
// flow for each platform ships in a later phase. The status field
// drives the chip on the UI; status transitions today are manual.

export const SUPPORTED_PLATFORMS = [
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "HUBRISE",
  "STUART",
  "UBER_DIRECT",
] as const;
export type PlatformId = (typeof SUPPORTED_PLATFORMS)[number];

export type ConnectionStatus =
  | "not_connected"
  | "pending"
  | "connected"
  | "suspended"
  | "error";

export interface UpsertConnectionDto {
  brandId: string;
  locationId: string;
  platform: PlatformId;
  status?: ConnectionStatus;
  externalStoreId?: string | null;
  externalBrandId?: string | null;
  integrationId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class BrandConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All connections for a brand, ordered by platform. Auto-fills missing
   *  platforms with a placeholder "not_connected" row in-memory so the UI
   *  always renders one card per supported platform. */
  async listForBrand(tenantId: string, brandId: string) {
    await this.assertBrand(tenantId, brandId);
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, brandId },
    });
    return SUPPORTED_PLATFORMS.map((platform) => {
      const existing = rows.find((r) => r.platform === platform);
      if (existing) return existing;
      return {
        id: null,
        tenantId,
        brandId,
        locationId: null,
        platform,
        status: "not_connected" as const,
        externalStoreId: null,
        externalBrandId: null,
        integrationId: null,
        lastSyncAt: null,
        lastWebhookAt: null,
        lastError: null,
        metadata: {} as Record<string, unknown>,
        createdAt: null,
        updatedAt: null,
      };
    });
  }

  /** All connections at a location, across every brand. */
  async listForLocation(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    return this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, locationId },
      include: { brand: { select: { id: true, name: true } } },
      orderBy: [{ platform: "asc" }, { createdAt: "asc" }],
    });
  }

  async upsert(tenantId: string, dto: UpsertConnectionDto) {
    if (!SUPPORTED_PLATFORMS.includes(dto.platform)) {
      throw new BadRequestException(`Unsupported platform: ${dto.platform}`);
    }
    await this.assertBrand(tenantId, dto.brandId);
    await this.assertLocation(tenantId, dto.locationId);

    return this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: dto.brandId,
          locationId: dto.locationId,
          platform: dto.platform,
        },
      },
      create: {
        tenantId,
        brandId: dto.brandId,
        locationId: dto.locationId,
        platform: dto.platform,
        status: dto.status ?? "not_connected",
        externalStoreId: dto.externalStoreId ?? null,
        externalBrandId: dto.externalBrandId ?? null,
        integrationId: dto.integrationId ?? null,
        metadata: (dto.metadata ?? {}) as any,
      },
      update: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.externalStoreId !== undefined && { externalStoreId: dto.externalStoreId }),
        ...(dto.externalBrandId !== undefined && { externalBrandId: dto.externalBrandId }),
        ...(dto.integrationId !== undefined && { integrationId: dto.integrationId }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata as any }),
      },
    });
  }

  async disconnect(tenantId: string, id: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException("Connection not found");
    return this.prisma.brandPlatformConnection.update({
      where: { id },
      data: {
        status: "not_connected",
        externalStoreId: null,
        externalBrandId: null,
        integrationId: null,
        lastError: null,
      },
    });
  }

  private async assertBrand(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }
}
