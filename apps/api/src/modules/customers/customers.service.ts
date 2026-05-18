import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface CreateCustomerDto {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  marketingConsent?: boolean;
  tags?: string[];
}

export interface UpdateCustomerDto {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  marketingConsent?: boolean;
  tags?: string[];
  isActive?: boolean;
}

export interface AddAddressDto {
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country?: string;
  isDefault?: boolean;
  coordinates?: { lat: number; lng: number };
}

export interface ValidatePromoDto {
  code: string;
  locationId: string;
  orderSubtotal: number;
}

const CUSTOMER_INCLUDE = {
  addresses: { orderBy: { isDefault: "desc" as const } },
  loyalty: true,
  _count: { select: { orders: true } },
} as const;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Customer CRUD ─────────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { search?: string; limit?: number; offset?: number } = {},
  ) {
    const { search, limit = 50, offset = 0 } = opts;

    const where: any = { tenantId, isActive: true };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        include: {
          _count: { select: { orders: true } },
          loyalty: { select: { points: true, tier: true, totalSpend: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, total, limit, offset };
  }

  async findOne(customerId: string, tenantId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      include: CUSTOMER_INCLUDE,
    });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  async findOrCreate(
    tenantId: string,
    dto: { email?: string; phone?: string; firstName?: string; lastName?: string },
  ) {
    const { email, phone } = dto;
    if (!email && !phone) throw new ConflictException("email or phone required");

    const existing = await this.prisma.customer.findFirst({
      where: {
        tenantId,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });
    if (existing) return existing;

    return this.prisma.customer.create({
      data: {
        tenantId,
        email: email ?? null,
        phone: phone ?? null,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
      },
    });
  }

  async create(tenantId: string, dto: CreateCustomerDto) {
    if (dto.email) {
      const existing = await this.prisma.customer.findFirst({
        where: { tenantId, email: dto.email },
      });
      if (existing) throw new ConflictException("Customer with this email already exists");
    }

    return this.prisma.customer.create({
      data: {
        tenantId,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
        marketingConsent: dto.marketingConsent ?? false,
        tags: dto.tags ?? [],
      },
      include: CUSTOMER_INCLUDE,
    });
  }

  async update(customerId: string, tenantId: string, dto: UpdateCustomerDto) {
    await this.assertAccess(customerId, tenantId);
    return this.prisma.customer.update({
      where: { id: customerId },
      data: {
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.marketingConsent !== undefined && { marketingConsent: dto.marketingConsent }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: CUSTOMER_INCLUDE,
    });
  }

  // ── Addresses ─────────────────────────────────────────────────────────────

  async addAddress(customerId: string, tenantId: string, dto: AddAddressDto) {
    await this.assertAccess(customerId, tenantId);

    if (dto.isDefault) {
      await this.prisma.customerAddress.updateMany({
        where: { customerId },
        data: { isDefault: false },
      });
    }

    return this.prisma.customerAddress.create({
      data: {
        customerId,
        label: dto.label ?? null,
        line1: dto.line1,
        line2: dto.line2 ?? null,
        city: dto.city,
        postcode: dto.postcode,
        country: dto.country ?? "GB",
        isDefault: dto.isDefault ?? false,
        coordinates: dto.coordinates as any ?? null,
      },
    });
  }

  async removeAddress(customerId: string, addressId: string, tenantId: string) {
    await this.assertAccess(customerId, tenantId);
    await this.prisma.customerAddress.deleteMany({
      where: { id: addressId, customerId },
    });
  }

  // ── Order history ──────────────────────────────────────────────────────────

  async getOrderHistory(
    customerId: string,
    tenantId: string,
    opts: { limit?: number; offset?: number } = {},
  ) {
    await this.assertAccess(customerId, tenantId);
    const { limit = 20, offset = 0 } = opts;

    return this.prisma.order.findMany({
      where: { customerId, tenantId },
      select: {
        id: true, displayId: true, platform: true, status: true,
        fulfillmentType: true, total: true, createdAt: true,
        items: { select: { name: true, quantity: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
  }

  // ── Loyalty ────────────────────────────────────────────────────────────────

  async getLoyalty(customerId: string, tenantId: string) {
    await this.assertAccess(customerId, tenantId);
    return (
      (await this.prisma.loyaltyAccount.findUnique({ where: { customerId } })) ??
      { customerId, points: 0, tier: "BRONZE", totalSpend: 0, totalOrders: 0 }
    );
  }

  async adjustLoyaltyPoints(
    customerId: string,
    tenantId: string,
    delta: number,
    reason: string,
  ) {
    await this.assertAccess(customerId, tenantId);

    return this.prisma.loyaltyAccount.upsert({
      where: { customerId },
      create: {
        customerId,
        tenantId,
        points: Math.max(0, delta),
        metadata: { adjustments: [{ delta, reason, at: new Date().toISOString() }] },
      },
      update: {
        points: { increment: delta },
        metadata: {
          // Append to adjustments array via raw update would need JSON manipulation;
          // using a simple update for the points value is sufficient for Phase E
        },
      },
    });
  }

  // ── Promo Codes ────────────────────────────────────────────────────────────

  async validatePromo(tenantId: string, dto: ValidatePromoDto) {
    const promo = await this.prisma.promoCode.findFirst({
      where: {
        tenantId,
        code: dto.code.toUpperCase(),
        isActive: true,
        OR: [{ startAt: null }, { startAt: { lte: new Date() } }],
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }] },
          { OR: [{ maxUses: null }, { usedCount: { lt: this.prisma.promoCode.fields.maxUses as any } }] },
        ],
      },
    });

    if (!promo) return { valid: false, reason: "Invalid or expired promo code" };

    // Location restriction check
    if (promo.locationIds.length > 0 && !promo.locationIds.includes(dto.locationId)) {
      return { valid: false, reason: "Promo code not valid for this location" };
    }

    if (promo.minOrderValue && dto.orderSubtotal < Number(promo.minOrderValue)) {
      return {
        valid: false,
        reason: `Minimum order of £${promo.minOrderValue} required`,
      };
    }

    const discount = this.calculateDiscount(promo, dto.orderSubtotal);
    return {
      valid: true,
      promoId: promo.id,
      code: promo.code,
      type: promo.type,
      discount,
      description: promo.description,
    };
  }

  async createPromo(tenantId: string, dto: {
    code: string;
    type: string;
    value: number;
    description?: string;
    minOrderValue?: number;
    maxUses?: number;
    expiresAt?: string;
    locationIds?: string[];
  }) {
    return this.prisma.promoCode.create({
      data: {
        tenantId,
        code: dto.code.toUpperCase(),
        type: dto.type as any,
        value: dto.value,
        description: dto.description ?? null,
        minOrderValue: dto.minOrderValue ?? null,
        maxUses: dto.maxUses ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        locationIds: dto.locationIds ?? [],
      },
    });
  }

  async listPromos(tenantId: string) {
    return this.prisma.promoCode.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async togglePromo(promoId: string, tenantId: string) {
    const promo = await this.prisma.promoCode.findFirst({
      where: { id: promoId, tenantId },
    });
    if (!promo) throw new NotFoundException("Promo code not found");
    return this.prisma.promoCode.update({
      where: { id: promoId },
      data: { isActive: !promo.isActive },
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async assertAccess(customerId: string, tenantId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  private calculateDiscount(promo: any, subtotal: number): number {
    switch (promo.type) {
      case "PERCENTAGE":
        return Math.round(subtotal * (Number(promo.value) / 100) * 100) / 100;
      case "FIXED_AMOUNT":
        return Math.min(Number(promo.value), subtotal);
      case "FREE_DELIVERY":
        return 0; // delivery fee waived — applied at order level
      default:
        return 0;
    }
  }
}
