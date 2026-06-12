import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import { PaymentsService } from "../payments/payments.service";

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
  // Phase AP-8 — when set to "CARD", checkout() returns a Stripe Checkout
  // Session URL the storefront should redirect the browser to. Defaults
  // to "CASH" if absent so existing callers keep working.
  paymentMethod?: "CASH" | "CARD";
  // Phase AP-5 — when the storefront customer is signed in, the
  // CustomerAccount id is threaded through here so the Order can be
  // attributed to them for the "My Orders" page. Null/undefined
  // means guest checkout — order is still placed, just unlinked.
  customerAccountId?: string;
}

@Injectable()
export class OrderingService {
  private readonly logger = new Logger(OrderingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly promoCodes: PromoCodesService,
    // Phase AP-8 — Stripe Checkout Session for card payments. Injected
    // optionally so the module doesn't blow up at boot if Stripe creds
    // aren't set yet on a fresh deploy.
    private readonly payments: PaymentsService,
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

    // Phase AP fix #2 — mirror POS's findActiveMenuForLocation exactly.
    // A single OR-then-orderBy(updatedAt) was racing the location-scoped
    // menu against the brand-scoped one, so when the operator's tenant
    // had BOTH (e.g. a legacy "Main" brand menu + a freshly published
    // location-scoped "test 2"), the storefront could pick whichever
    // was edited most recently — even if it was the wrong one with
    // only one category.
    //
    // We now explicitly try location-scoped first, then fall back to
    // brand-scoped. Same order POS already uses; same menu always
    // chosen.
    const menuInclude = {
      categories: {
        orderBy: { sortOrder: "asc" as const },
        include: {
          items: {
            where: { item: { isAvailable: true } },
            orderBy: { sortOrder: "asc" as const },
            include: {
              item: {
                include: {
                  modifierGroupLinks: {
                    include: {
                      group: {
                        include: {
                          options: {
                            where: { isAvailable: true },
                            orderBy: { sortOrder: "asc" as const },
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
    };

    const menu =
      (await this.prisma.menu.findFirst({
        where: { locationId: location.id, isActive: true, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        include: menuInclude,
      })) ??
      (await this.prisma.menu.findFirst({
        where: {
          brandId: location.brandId,
          isActive: true,
          deletedAt: null,
          locationId: null,
        },
        orderBy: { updatedAt: "desc" },
        include: menuInclude,
      }));

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

    // Phase AP-8 pre-flight — for CARD orders, validate the location
    // has a Stripe Connect account configured BEFORE we create the
    // Order row. Otherwise a failed createCheckoutSession leaves an
    // orphan order on the staff Orders board and a 500 in the
    // customer's browser. The actual Checkout Session is built later
    // (after the Order exists so the success_url can reference it).
    if (dto.paymentMethod === "CARD") {
      const connect = await this.payments.resolveConnectAccount(
        location.brand.tenantId,
        location.id,
      );
      if (!connect) {
        throw new BadRequestException(
          "This restaurant hasn't set up card payments yet. Please choose Cash, or contact the restaurant.",
        );
      }
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

    const order = await this.ordersService.create(
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
        paymentMethod: dto.paymentMethod ?? "CASH",
        paymentStatus: dto.paymentMethod === "CARD" ? "PENDING" : "PENDING",
        // Phase AP-5 — attribute the order to the signed-in customer
        // so it shows up on their My Orders page. Guest checkouts
        // pass undefined, which OrdersService.create treats as null.
        customerAccountId: dto.customerAccountId,
      } as any,
      location.brand.tenantId,
    );

    // Phase AP-8 — cash orders flow straight to the staff Orders board
    // as today. Card orders, on the other hand, need the customer to
    // complete payment through Stripe Checkout *first*; we return the
    // hosted-checkout URL for the storefront to redirect to. The order
    // joins the staff board only once the Stripe webhook reports
    // authorization (payment_intent.amount_capturable_updated).
    if (dto.paymentMethod === "CARD") {
      const origin = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
      const successUrl = `${origin}/order/${slug}/confirmation?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${origin}/order/${slug}?canceledOrderId=${order.id}`;

      const { url } = await this.payments.createCheckoutSession({
        tenantId: location.brand.tenantId,
        orderId: order.id,
        successUrl,
        cancelUrl,
        customerEmail: dto.customerInfo.email,
      });

      return { ...order, checkoutUrl: url } as any;
    }

    return order;
  }

  async getOrderStatus(orderId: string) {
    // Phase AP follow-up: the customer-facing storefront polls this
    // endpoint while it shows the "waiting for restaurant" screen and
    // then for live tracking once the order is accepted. We surface
    // everything the screen needs:
    //   • orderNumber for the customer-facing #N badge
    //   • outForDeliveryAt + deliveredAt for the timeline
    //   • location.name so the cancel screen can say which shop
    //     cancelled
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        displayId: true,
        orderNumber: true,
        status: true,
        fulfillmentType: true,
        estimatedReadyAt: true,
        scheduledFor: true,
        receivedAt: true,
        acceptedAt: true,
        preparingAt: true,
        readyAt: true,
        outForDeliveryAt: true,
        deliveredAt: true,
        cancelledAt: true,
        cancelReason: true,
        total: true,
        location: { select: { name: true } },
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
