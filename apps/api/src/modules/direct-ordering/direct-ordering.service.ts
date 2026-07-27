import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AP — direct online ordering settings.
//
// One row per location with sensible defaults. The public storefront
// reads this to decide which payment methods + order types to show and
// how to advertise prep times. The admin tab in POS edits it.

export interface UpdateDirectOrderingConfigDto {
  deliveryPrepMinutes?: number;
  collectionPrepMinutes?: number;
  acceptsCash?: boolean;
  acceptsCard?: boolean;
  acceptsDelivery?: boolean;
  acceptsCollection?: boolean;
  scheduleMaxDaysAhead?: number;
  scheduleSlotMinutes?: number;
  minOrderForDelivery?: number | null;
  heroImageUrl?: string | null;
  showItemImages?: boolean;
}

@Injectable()
export class DirectOrderingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Get-or-create with defaults — the storefront always wants a row,
   *  even on a brand-new location that never visited the admin tab. */
  async get(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const existing = await this.prisma.directOrderingConfig.findUnique({
      where: { locationId },
    });
    if (existing) return existing;
    return this.prisma.directOrderingConfig.create({
      data: { tenantId, locationId },
    });
  }

  /** Same shape but no auth check — the public storefront calls this. */
  async getPublic(locationId: string) {
    const existing = await this.prisma.directOrderingConfig.findUnique({
      where: { locationId },
    });
    if (existing) return existing;
    // Don't write to the DB on a public read — return ephemeral defaults.
    return {
      id: "default",
      tenantId: "",
      locationId,
      deliveryPrepMinutes: 45,
      collectionPrepMinutes: 20,
      acceptsCash: true,
      acceptsCard: true,
      acceptsDelivery: true,
      acceptsCollection: true,
      scheduleMaxDaysAhead: 7,
      scheduleSlotMinutes: 15,
      minOrderForDelivery: null,
      heroImageUrl: null,
      showItemImages: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async update(
    tenantId: string,
    locationId: string,
    dto: UpdateDirectOrderingConfigDto,
  ) {
    await this.assertLocation(tenantId, locationId);
    return this.prisma.directOrderingConfig.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        ...this.cleanWriteDto(dto),
      },
      update: this.cleanWriteDto(dto),
    });
  }

  private cleanWriteDto(dto: UpdateDirectOrderingConfigDto) {
    const out: Record<string, unknown> = {};
    if (dto.deliveryPrepMinutes !== undefined)
      out.deliveryPrepMinutes = dto.deliveryPrepMinutes;
    if (dto.collectionPrepMinutes !== undefined)
      out.collectionPrepMinutes = dto.collectionPrepMinutes;
    if (dto.acceptsCash !== undefined) out.acceptsCash = dto.acceptsCash;
    if (dto.acceptsCard !== undefined) out.acceptsCard = dto.acceptsCard;
    if (dto.acceptsDelivery !== undefined)
      out.acceptsDelivery = dto.acceptsDelivery;
    if (dto.acceptsCollection !== undefined)
      out.acceptsCollection = dto.acceptsCollection;
    if (dto.scheduleMaxDaysAhead !== undefined)
      out.scheduleMaxDaysAhead = dto.scheduleMaxDaysAhead;
    if (dto.scheduleSlotMinutes !== undefined)
      out.scheduleSlotMinutes = dto.scheduleSlotMinutes;
    if (dto.minOrderForDelivery !== undefined)
      out.minOrderForDelivery = dto.minOrderForDelivery;
    if (dto.heroImageUrl !== undefined) out.heroImageUrl = dto.heroImageUrl;
    if (dto.showItemImages !== undefined)
      out.showItemImages = dto.showItemImages;
    return out;
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  // ── Phase AW: brand-keyed variant ─────────────────────────────────────
  //
  // Same shape as the location-keyed methods above, but the row is
  // keyed by brandId. The Brand model carries customer-facing identity
  // (address, phone, logo, custom domain, Stripe Connect) so the
  // storefront is fully self-contained per brand. Storefront reads
  // resolve config by brand from AW-3 onwards; the location variants
  // stay for the old admin tab until AW-4 retires them.

  async getByBrand(tenantId: string, brandId: string) {
    await this.assertBrand(tenantId, brandId);
    const existing = await (this.prisma as any).directOrderingConfig.findUnique({
      where: { brandId },
    });
    if (existing) return existing;
    return (this.prisma as any).directOrderingConfig.create({
      data: { tenantId, brandId },
    });
  }

  /** Public read for the storefront — no tenant context. Returns
   *  ephemeral defaults if the brand never visited the admin tab so
   *  the page still renders. Never writes. */
  async getPublicByBrand(brandId: string) {
    const existing = await (this.prisma as any).directOrderingConfig.findUnique({
      where: { brandId },
    });
    if (existing) return existing;
    return {
      id: "default",
      tenantId: "",
      brandId,
      locationId: null,
      deliveryPrepMinutes: 45,
      collectionPrepMinutes: 20,
      acceptsCash: true,
      acceptsCard: true,
      acceptsDelivery: true,
      acceptsCollection: true,
      scheduleMaxDaysAhead: 7,
      scheduleSlotMinutes: 15,
      minOrderForDelivery: null,
      heroImageUrl: null,
      showItemImages: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async updateByBrand(
    tenantId: string,
    brandId: string,
    dto: UpdateDirectOrderingConfigDto,
  ) {
    await this.assertBrand(tenantId, brandId);
    return (this.prisma as any).directOrderingConfig.upsert({
      where: { brandId },
      create: {
        tenantId,
        brandId,
        ...this.cleanWriteDto(dto),
      },
      update: this.cleanWriteDto(dto),
    });
  }

  private async assertBrand(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
  }
}
