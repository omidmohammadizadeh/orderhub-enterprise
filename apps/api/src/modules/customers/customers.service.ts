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

  // ── Customer directory (order-derived) ────────────────────────────────────
  //
  // The Customer table only holds direct/online signups — marketplace buyers
  // (Deliveroo / Uber Eats / Just Eat / HubRise) exist purely as order rows.
  // The directory aggregates the last 365 days of orders into one row per
  // customer identity so the dashboard can show EVERY customer, filterable by
  // channel and by segment (new = single order, returning = 2+).
  //
  // Identity mirrors OrdersService.attachCustomerVisitCounts: marketplaces
  // rotate a masked phone per order, so those key on name+postcode; our own
  // channels key on name+phone+postcode.
  async directory(
    tenantId: string,
    opts: { channel?: string; segment?: string; search?: string } = {},
  ) {
    const MARKETPLACES = new Set(["JUST_EAT", "UBER_EATS", "DELIVEROO", "HUBRISE"]);
    const channel = (opts.channel ?? "").toUpperCase();
    const channelSources: Record<string, string[]> = {
      POS: ["POS"],
      ONLINE: ["ONLINE", "DIRECT"],
      DELIVEROO: ["DELIVEROO"],
      UBER_EATS: ["UBER_EATS"],
      JUST_EAT: ["JUST_EAT"],
      HUBRISE: ["HUBRISE"],
      WHATSAPP: ["WHATSAPP"],
    };

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        isSandbox: false,
        status: { notIn: ["CANCELLED", "REJECTED", "FAILED"] },
        createdAt: { gte: oneYearAgo },
        ...(channelSources[channel]
          ? { orderSource: { in: channelSources[channel] as any } }
          : {}),
      },
      select: {
        customerName: true,
        customerPhone: true,
        customerInfo: true,
        deliveryAddress: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        orderSource: true,
        platform: true,
        integrationSource: true,
        viaHubrise: true,
        total: true,
        createdAt: true,
      },
      // newest first → the first row seen per identity carries the freshest
      // contact details, older rows only backfill gaps
      orderBy: { createdAt: "desc" },
      take: 20_000,
    });

    const norm = (s: string | null | undefined) =>
      (s ?? "").replace(/\s+/g, "").toLowerCase();

    interface Row {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      orders: number;
      totalSpend: number;
      channels: Set<string>;
      firstOrderAt: Date;
      lastOrderAt: Date;
    }
    const byId = new Map<string, Row>();

    for (const o of orders) {
      const name = (o.customerName ?? "").trim();
      if (!name) continue;
      const isMarketplace =
        MARKETPLACES.has(o.integrationSource as any) ||
        MARKETPLACES.has(o.platform as any) ||
        o.viaHubrise;
      const addr = (o.deliveryAddress ?? {}) as Record<string, any>;
      const postcode = o.postcode ?? addr.postcode ?? "";
      const id = isMarketplace
        ? `mkt|${norm(name)}|${norm(postcode)}`
        : `dir|${norm(name)}|${norm(o.customerPhone)}|${norm(postcode)}`;

      const info = (o.customerInfo ?? {}) as Record<string, any>;
      const addressStr =
        [
          addr.line1 ?? o.addressLine1,
          addr.line2 ?? o.addressLine2,
          addr.city ?? o.city,
          addr.postcode ?? o.postcode,
        ]
          .filter(Boolean)
          .join(", ") || null;

      const existing = byId.get(id);
      if (existing) {
        existing.orders += 1;
        existing.totalSpend += Number(o.total ?? 0);
        existing.channels.add(o.orderSource);
        if (o.createdAt < existing.firstOrderAt) existing.firstOrderAt = o.createdAt;
        existing.phone ||= o.customerPhone ?? null;
        existing.email ||= (info.email as string) ?? null;
        existing.address ||= addressStr;
      } else {
        byId.set(id, {
          id,
          name,
          phone: o.customerPhone ?? null,
          email: (info.email as string) ?? null,
          address: addressStr,
          orders: 1,
          totalSpend: Number(o.total ?? 0),
          channels: new Set([o.orderSource]),
          firstOrderAt: o.createdAt,
          lastOrderAt: o.createdAt,
        });
      }
    }

    let rows = Array.from(byId.values());

    const segment = (opts.segment ?? "all").toLowerCase();
    if (segment === "new") rows = rows.filter((r) => r.orders === 1);
    else if (segment === "returning") rows = rows.filter((r) => r.orders > 1);

    const q = (opts.search ?? "").trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.phone ?? "").toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.address ?? "").toLowerCase().includes(q),
      );
    }

    rows.sort((a, b) => b.lastOrderAt.getTime() - a.lastOrderAt.getTime());

    return {
      data: rows.slice(0, 500).map((r) => ({
        ...r,
        channels: Array.from(r.channels),
        totalSpend: Math.round(r.totalSpend * 100) / 100,
      })),
      total: rows.length,
    };
  }

  /** Resolve a location's tenant — used by the public VoIP ring webhook. */
  async tenantForLocation(locationId: string): Promise<string | null> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { brand: { select: { tenantId: true } } },
    });
    return loc?.brand.tenantId ?? null;
  }

  // ── Caller-ID lookup ──────────────────────────────────────────────────────
  //
  // Match a ringing landline number against past orders so the POS can
  // autofill the name and offer previous delivery addresses. Phone formats
  // vary (spaces, +44 vs 0), so match on the digit-normalised suffix.
  async lookupByPhone(tenantId: string, rawPhone: string) {
    const digits = (rawPhone ?? "").replace(/\D/g, "");
    if (digits.length < 6) return null;
    // Last 9 digits uniquely identify a UK number across 0/+44 forms.
    const suffix = digits.slice(-9);

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        isSandbox: false,
        customerPhone: { not: null },
        createdAt: { gte: oneYearAgo },
      },
      select: {
        customerName: true,
        customerPhone: true,
        customerInfo: true,
        deliveryAddress: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5_000,
    });

    const mine = orders.filter(
      (o) => (o.customerPhone ?? "").replace(/\D/g, "").endsWith(suffix),
    );
    if (mine.length === 0) return null;

    const name =
      mine.find((o) => (o.customerName ?? "").trim())?.customerName?.trim() ??
      "Customer";
    const email =
      (mine
        .map((o) => ((o.customerInfo ?? {}) as Record<string, any>).email)
        .find(Boolean) as string) ?? null;

    // Distinct previous addresses, newest first, capped for the popup.
    const seen = new Set<string>();
    const addresses: Array<{
      line1: string;
      line2: string | null;
      city: string | null;
      postcode: string | null;
    }> = [];
    for (const o of mine) {
      const a = (o.deliveryAddress ?? {}) as Record<string, any>;
      const line1 = (a.line1 ?? o.addressLine1 ?? "").trim();
      if (!line1) continue;
      const addr = {
        line1,
        line2: (a.line2 ?? o.addressLine2 ?? null) || null,
        city: (a.city ?? o.city ?? null) || null,
        postcode: (a.postcode ?? o.postcode ?? null) || null,
      };
      const key = `${line1}|${addr.postcode ?? ""}`.toLowerCase().replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push(addr);
      if (addresses.length >= 4) break;
    }

    return { name, orders: mine.length, email, addresses };
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
