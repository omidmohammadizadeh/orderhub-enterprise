import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";

export interface CheckoutItemDto {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  modifiers?: Array<{ name: string; price: number }>;
  notes?: string;
}

export interface CheckoutDto {
  idempotencyKey: string;
  fulfillmentType: "PICKUP" | "DELIVERY" | "DINE_IN";
  customerInfo: { name: string; phone?: string; email?: string };
  deliveryAddress?: { line1: string; line2?: string; city: string; postcode: string };
  items: CheckoutItemDto[];
  subtotal: number;
  deliveryFee?: number;
  taxAmount?: number;
  discount?: number;
  total: number;
  specialInstructions?: string;
  promoCode?: string;
}

@Injectable()
export class OrderingService {
  private readonly logger = new Logger(OrderingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly promoCodes: PromoCodesService,
  ) {}

  /**
   * Phase AP — validate a promo code from the storefront cart.
   * The customer has no auth, so we resolve the tenant via the slug
   * lookup first, then delegate to the standard validate flow.
   */
  async validatePromoForStorefront(
    slug: string,
    body: { code: string; subtotal: number },
  ) {
    const location = await this.prisma.location.findFirst({
      where: { OR: [{ onlineOrderingSlug: slug }, { slug }] },
      include: { brand: { select: { tenantId: true } } },
    });
    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }
    return this.promoCodes.validate(location.brand.tenantId, {
      code: body.code,
      locationId: location.id,
      subtotal: body.subtotal,
    });
  }

  async getStorefrontBySlug(slug: string) {
    // Phase AN — `onlineOrderingSlug` is the new operator-facing slug;
    // older locations may still only have the legacy `slug`. Resolve
    // either so old printed flyers and QR codes keep working.
    const location = await this.prisma.location.findFirst({
      where: {
        OR: [{ onlineOrderingSlug: slug }, { slug }],
      },
      include: {
        brand: {
          select: { id: true, name: true, slug: true, logoUrl: true, metadata: true },
        },
      },
    });

    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }

    // Prefer the location-scoped active menu (Phase AK shape) then fall
    // back to the brand's published menu. We accept either status=PUBLISHED
    // or the legacy isActive=true so a freshly-edited menu isn't hidden
    // when the operator forgets to flip status.
    const menu = await this.prisma.menu.findFirst({
      where: {
        OR: [
          { locationId: location.id, isActive: true, deletedAt: null },
          {
            brandId: location.brandId,
            isActive: true,
            deletedAt: null,
            locationId: null,
          },
        ],
      },
      orderBy: { updatedAt: "desc" },
      include: {
        // Phase AP — needed for the storefront hero banner.
        // bannerImage was added in Phase AM; heroImage is a later
        // alternative slot. Both selected through to the client.
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: {
                        group: {
                          include: {
                            options: {
                              where: { isAvailable: true },
                              orderBy: { sortOrder: "asc" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Phase AP — surface the direct-ordering config + delivery zones so
    // the storefront can render prep times, accepted methods, and auto-
    // apply delivery fees by postcode. We read directly (no module dep
    // cycle) and fall back to permissive defaults for any location that
    // never visited the admin tab.
    const directConfig =
      (await this.prisma.directOrderingConfig.findUnique({
        where: { locationId: location.id },
      })) ?? {
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
      };
    const deliveryZones = await this.prisma.deliveryZone.findMany({
      where: { locationId: location.id, isActive: true },
      select: { postcodePrefix: true, fee: true, minOrderValue: true },
    });

    // Phase AP fix #4 — pick up categories that link to this menu
    // through the Phase-AK menuIds[] array but whose primary menuId
    // points elsewhere. They were silently dropped from the storefront
    // because the relation only follows the primary FK.
    const extraCategories = menu
      ? await this.prisma.menuCategory.findMany({
          where: {
            menuIds: { has: menu.id },
            menuId: { not: menu.id },
          },
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: {
                        group: {
                          include: {
                            options: {
                              where: { isAvailable: true },
                              orderBy: { sortOrder: "asc" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        })
      : [];
    if (menu && extraCategories.length > 0) {
      (menu as any).categories = [
        ...((menu as any).categories ?? []),
        ...extraCategories,
      ];
    }

    // Phase AP fix #4 — also surface the brand's full modifier-group
    // catalog. Multi-SKU products store per-SKU group IDs in
    // productSkus[].modifierGroups (plain string arrays, no FK), so the
    // storefront's modifier modal needs this list to look them up,
    // same as POS already does.
    const brandModifierGroups = await this.prisma.modifierGroup.findMany({
      where: { brandId: location.brandId },
      include: {
        options: {
          where: { isAvailable: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    return {
      directConfig,
      deliveryZones,
      brandModifierGroups,
      location: {
        id: location.id,
        name: location.name,
        slug: location.onlineOrderingSlug ?? location.slug,
        phone: location.phone,
        about: location.about,
        logoUrl: location.logoUrl,
        addressLine1: location.addressLine1,
        addressLine2: location.addressLine2,
        city: location.city,
        postcode: location.postcode,
        country: location.country,
        address: location.address,
        timezone: location.timezone,
        openingHours: location.openingHours,
        deliveryConfig: location.deliveryConfig,
        status: location.status,
        busyMode: location.busyMode,
        currentPrepTime: location.currentPrepTime,
      },
      brand: location.brand,
      menu,
      isOpen: this.isCurrentlyOpen(location.openingHours as any, location.timezone),
    };
  }

  async checkout(slug: string, dto: CheckoutDto) {
    const location = await this.prisma.location.findFirst({
      where: { OR: [{ onlineOrderingSlug: slug }, { slug }] },
      include: { brand: { select: { tenantId: true } } },
    });

    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }

    if (!this.isCurrentlyOpen(location.openingHours as any[], location.timezone)) {
      throw new BadRequestException("Store is currently closed");
    }

    const items = dto.items.map((item) => ({
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.unitPrice * item.quantity + (item.modifiers?.reduce((s, m) => s + m.price * item.quantity, 0) ?? 0),
      modifiers: item.modifiers ?? [],
      notes: item.notes,
    }));

    return this.ordersService.create(
      {
        locationId: location.id,
        orderSource: "ONLINE",
        fulfillmentType: dto.fulfillmentType,
        customerInfo: dto.customerInfo,
        deliveryAddress: dto.deliveryAddress,
        items,
        subtotal: dto.subtotal,
        taxAmount: dto.taxAmount ?? 0,
        deliveryFee: dto.deliveryFee ?? 0,
        discount: dto.discount ?? 0,
        total: dto.total,
        specialInstructions: dto.specialInstructions,
        idempotencyKey: dto.idempotencyKey,
      },
      location.brand.tenantId,
    );
  }

  async getOrderStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        displayId: true,
        status: true,
        fulfillmentType: true,
        estimatedReadyAt: true,
        acceptedAt: true,
        preparingAt: true,
        readyAt: true,
        cancelledAt: true,
        cancelReason: true,
        total: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  /**
   * Handles BOTH opening-hours shapes:
   *   • Legacy array `[{ day: 1, open: "16:00", close: "23:30" }, …]`
   *   • Phase AN map `{ monday: { enabled, slots: [{ from, to }] }, … }`
   *
   * Returns true when no hours are configured (treat as 24/7 open) so a
   * brand-new location can still place orders while the operator is
   * filling things in.
   */
  private isCurrentlyOpen(openingHours: any, timezone: string): boolean {
    if (!openingHours) return true;

    const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
    const dayOfWeek = now.getDay(); // 0=Sun
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    // Phase AN map shape
    if (!Array.isArray(openingHours) && typeof openingHours === "object") {
      const keys = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ] as const;
      const today = openingHours[keys[dayOfWeek] as string];
      if (!today || !today.enabled) return false;
      const slots = Array.isArray(today.slots) ? today.slots : [];
      return slots.some(
        (s: { from?: string; to?: string }) =>
          !!s.from && !!s.to && currentTime >= s.from && currentTime < s.to,
      );
    }

    // Legacy array shape
    if (Array.isArray(openingHours)) {
      if (openingHours.length === 0) return true;
      const todayHours = openingHours.find((h: any) => h.day === dayOfWeek);
      if (!todayHours) return false;
      return currentTime >= todayHours.open && currentTime < todayHours.close;
    }

    return true;
  }
}
