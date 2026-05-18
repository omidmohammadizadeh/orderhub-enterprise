import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";

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
  ) {}

  async getStorefrontBySlug(slug: string) {
    const location = await this.prisma.location.findUnique({
      where: { slug },
      include: {
        brand: {
          select: { id: true, name: true, slug: true, metadata: true },
        },
      },
    });

    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }

    // Find published menu for this brand
    const menu = await this.prisma.menu.findFirst({
      where: { brandId: location.brandId, status: "PUBLISHED", deletedAt: null, isActive: true },
      include: {
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: { item: true },
            },
          },
        },
      },
    });

    return {
      location: {
        id: location.id,
        name: location.name,
        slug: location.slug,
        phone: location.phone,
        address: location.address,
        timezone: location.timezone,
        openingHours: location.openingHours,
        deliveryConfig: location.deliveryConfig,
      },
      brand: location.brand,
      menu,
      isOpen: this.isCurrentlyOpen(location.openingHours as any[], location.timezone),
    };
  }

  async checkout(slug: string, dto: CheckoutDto) {
    const location = await this.prisma.location.findUnique({
      where: { slug },
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

  private isCurrentlyOpen(
    openingHours: Array<{ day: number; open: string; close: string }>,
    timezone: string,
  ): boolean {
    if (!openingHours || openingHours.length === 0) return true;

    const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
    const dayOfWeek = now.getDay(); // 0=Sun
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const todayHours = openingHours.find((h) => h.day === dayOfWeek);
    if (!todayHours) return false;

    return currentTime >= todayHours.open && currentTime < todayHours.close;
  }
}
