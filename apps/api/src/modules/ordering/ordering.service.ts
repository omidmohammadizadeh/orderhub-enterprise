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
import { MenuAvailabilityService } from "../inventory/menu-availability.service";
import { PauseService } from "../pauses/pause.service";
import { MarketingService } from "../marketing/marketing.service";

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
  /** ISO timestamp when the customer scheduled the order for later. */
  scheduledFor?: string;
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
    // Phase AW-14 — strip items snoozed for ONLINE from the menu before
    // returning. Single round-trip per storefront load.
    private readonly menuAvailability: MenuAvailabilityService,
    // Phase AW-15 — resolve current pause state so the storefront can
    // render the "currently not accepting orders" banner and checkout
    // can refuse to land a new Order against a paused brand.
    private readonly pauses: PauseService,
    // Phase AW-19 — pick + apply the best active marketing campaign at
    // storefront load + checkout time. Audience bucket is resolved
    // per-customer so a NEW customer's "first order 20% off" only
    // fires for actual newcomers.
    private readonly marketing: MarketingService,
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
      where: { OR: [{ onlineOrderingSlug: slug }, { slug }, { id: slug }] },
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

  async getStorefrontBySlug(slug: string, brandIdOverride?: string) {
    // Phase AN — `onlineOrderingSlug` is the new operator-facing slug;
    // older locations may still only have the legacy `slug`. Resolve
    // either so old printed flyers and QR codes keep working.
    //
    // Phase AW — when `brandIdOverride` is set (because the customer
    // arrived via /brand/<slug> → /order/<slug>?brand=<id>), we
    // re-fetch the full brand row to overlay its storefront identity
    // onto the location's. The brand wins on every customer-facing
    // field; the location still drives ops fields (timezone, opening
    // hours, delivery zones, prep config).
    const location = await this.prisma.location.findFirst({
      where: {
        OR: [{ onlineOrderingSlug: slug }, { slug }, { id: slug }],
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            metadata: true,
            // Phase AW-30 — brand-level opening hours + prep config
            // override the location's when set. Brand wins for "is the
            // shop open" + "how long is prep" so a kitchen running 3
            // virtual brands can run them on different schedules.
            openingHours: true,
            prepTime: true,
            busyExtraPrepTime: true,
          },
        },
      },
    });

    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }

    // Phase AW — load the brand row in full when the URL pinned one.
    // Falls back to the location.brand (light shape from include above)
    // if the override id doesn't belong to this location's brand or
    // can't be resolved, so a malformed URL never strands the customer
    // with no storefront at all.
    const overrideBrand = brandIdOverride
      ? await (this.prisma as any).brand.findUnique({
          where: { id: brandIdOverride },
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            about: true,
            phone: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            postcode: true,
            country: true,
            cuisine: true,
            onlineOrderingSlug: true,
            customDomain: true,
            stripeConnectedAccountId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            directOrderingEnabled: true,
            isSuspended: true,
            openingHours: true,
            prepTime: true,
            busyExtraPrepTime: true,
          },
        })
      : null;

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

    // Phase AW — when a brand is pinned, its menu must win. The
    // previous code keyed every menu lookup off the LOCATION (and the
    // location's primary brand), which is why the customer arrived on
    // a Monster Burgerz storefront but saw the Pizza Uno Pelton menu
    // after the back-to-menu reset. With brandIdOverride set we look
    // ONLY at menus published under that brand id; if the brand
    // doesn't have one yet we fall back to location/legacy resolution
    // so a half-set-up brand still shows the kitchen's menu rather
    // than an empty storefront.
    const menuBrandId = overrideBrand?.id ?? location.brandId;
    const menu = brandIdOverride
      ? (await this.prisma.menu.findFirst({
          where: {
            brandId: menuBrandId,
            isActive: true,
            deletedAt: null,
          },
          orderBy: { updatedAt: "desc" },
          include: menuInclude,
        })) ??
        (await this.prisma.menu.findFirst({
          where: { locationId: location.id, isActive: true, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          include: menuInclude,
        }))
      : (await this.prisma.menu.findFirst({
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
    //
    // Phase AW-30 — brand-keyed config wins when the URL pinned a brand.
    // The brand settings drawer writes DirectOrderingConfig by brandId
    // (one row per brand), so the location-keyed lookup we used before
    // never saw those edits and prep-time changes silently no-op'd on
    // brand storefronts.
    const directConfigBrandId = overrideBrand?.id ?? location.brandId;
    const directConfig =
      (directConfigBrandId
        ? await (this.prisma as any).directOrderingConfig.findUnique({
            where: { brandId: directConfigBrandId },
          })
        : null) ??
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
    // Phase AW-30 — when a brand is pinned, brand zones win. Falls back
    // to location zones when the brand has none configured yet so a
    // half-set-up brand doesn't lose delivery entirely.
    const zoneBrandId = overrideBrand?.id ?? location.brandId;
    const brandZones = zoneBrandId
      ? await (this.prisma as any).deliveryZone.findMany({
          where: { brandId: zoneBrandId, isActive: true },
          select: { postcodePrefix: true, fee: true, minOrderValue: true },
        })
      : [];
    const deliveryZones =
      brandZones.length > 0
        ? brandZones
        : await this.prisma.deliveryZone.findMany({
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

    // Phase AW-14 — drop items snoozed for ONLINE. Single query
    // covering every item across every category, then filter in-memory.
    if (menu) {
      const itemIds: string[] = [];
      for (const cat of (menu as any).categories ?? []) {
        for (const link of cat.items ?? []) {
          if (link?.item?.id) itemIds.push(link.item.id);
        }
      }
      const snoozed = await this.menuAvailability.getSnoozedItemIdsForChannel(
        "ONLINE",
        itemIds,
      );
      if (snoozed.size > 0) {
        for (const cat of (menu as any).categories ?? []) {
          cat.items = (cat.items ?? []).filter(
            (link: any) => !snoozed.has(link?.item?.id),
          );
        }
      }
    }

    // Phase AP fix #4 — also surface the brand's full modifier-group
    // catalog. Multi-SKU products store per-SKU group IDs in
    // productSkus[].modifierGroups (plain string arrays, no FK), so the
    // storefront's modifier modal needs this list to look them up,
    // same as POS already does.
    // Phase AW — when a brand is pinned, scope modifier groups to
    // THAT brand. Otherwise the storefront would resolve per-SKU
    // group ids against the kitchen's primary-brand catalog and miss
    // anything published only under the pinned virtual brand.
    const brandModifierGroups = await this.prisma.modifierGroup.findMany({
      where: { brandId: menuBrandId },
      include: {
        options: {
          where: { isAvailable: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    // Phase AW-30 — brand-level opening hours win when configured.
    // Brand.openingHours default is `{}` which we treat as "not set"
    // (legacy single-brand kitchens keep using their location hours).
    // Pinned brand → URL-pinned brand row; otherwise the location's
    // primary brand. Both surfaces consume the same value so the
    // banner ("we're closed") and the checkout guard agree.
    const activeBrandForOps =
      overrideBrand ?? (location.brand as unknown as typeof overrideBrand);
    const isHoursConfigured = (h: any) => {
      if (h == null) return false;
      if (Array.isArray(h)) return h.length > 0;
      if (typeof h === "object") return Object.keys(h).length > 0;
      return false;
    };
    const effectiveHours = isHoursConfigured(
      (activeBrandForOps as any)?.openingHours,
    )
      ? (activeBrandForOps as any).openingHours
      : location.openingHours;

    // Phase AW — apply the brand identity overlay. When a brand is
    // pinned via ?brand=<id>, every customer-facing field on the
    // storefront prefers brand-level data; the location keeps the
    // fields the customer doesn't see (timezone, opening hours, etc.).
    // Fall back to location-level when a brand field is null so a
    // half-configured brand doesn't strand the customer with blank
    // address / phone — the original location data is still better
    // than nothing.
    const b = overrideBrand;
    const locationView = {
      id: location.id,
      name: b?.name ?? location.name,
      slug: location.onlineOrderingSlug ?? location.slug,
      phone: b?.phone ?? location.phone,
      about: b?.about ?? location.about,
      logoUrl: b?.logoUrl ?? location.logoUrl,
      addressLine1: b?.addressLine1 ?? location.addressLine1,
      addressLine2: b?.addressLine2 ?? location.addressLine2,
      city: b?.city ?? location.city,
      postcode: b?.postcode ?? location.postcode,
      country: b?.country ?? location.country,
      // The raw `address` JSON column is location-only — no brand
      // equivalent — so we pass it through unchanged for any old
      // storefront code paths still reading from it.
      address: location.address,
      timezone: location.timezone,
      // Phase AW-30 — brand hours win when configured, location hours
      // are the fallback. `effectiveHours` is also fed to isCurrentlyOpen
      // below so the storefront banner + checkout guard agree.
      openingHours: effectiveHours,
      deliveryConfig: location.deliveryConfig,
      status: location.status,
      busyMode: location.busyMode,
      currentPrepTime: location.currentPrepTime,
      // Phase AP-8 / AW — application-fee config. Brand-level wins
      // when set (brand has its own Stripe Connect account); falls
      // through to location otherwise. The storefront cart's
      // "Service charge" line reads from here.
      applicationFeeMode: b?.applicationFeeMode ?? location.applicationFeeMode,
      applicationFeeFixedAmount:
        b?.applicationFeeFixedAmount != null
          ? Number(b.applicationFeeFixedAmount)
          : location.applicationFeeFixedAmount
            ? Number(location.applicationFeeFixedAmount)
            : null,
    };

    // Phase AW-15 — resolve current pause/busy state for this brand on
    // the ONLINE channel. The storefront uses `closed` to render a
    // banner ("Monster Burgerz currently is not accepting online
    // orders, reopening at …") and to disable Add/Checkout buttons
    // while still letting the customer browse the menu.
    const pauseSnapshot = await this.pauses.isPaused({
      locationId: location.id,
      brandId: overrideBrand?.id ?? null,
      channel: "ONLINE",
    });
    const brandView = b
      ? {
          id: b.id,
          name: b.name,
          slug: b.slug,
          logoUrl: b.logoUrl,
          cuisine: b.cuisine,
          about: b.about,
        }
      : location.brand;
    const closed = pauseSnapshot.paused
      ? {
          brandName:
            pauseSnapshot.brandName ??
            (brandView as any)?.name ??
            location.name,
          resumeAt: pauseSnapshot.resumeAt,
          reason: pauseSnapshot.reason,
        }
      : null;

    // Phase AW-19 — pick the best active marketing campaign for this
    // brand on the ONLINE channel. The storefront cart displays a
    // discount line "20% off applied" and reduces the total locally;
    // checkout() re-resolves server-side so a client tampering with
    // the discount can't cheat.
    //
    // Without the customer's id (the storefront response doesn't
    // know who's logged in yet — the page hydrates auth on the
    // client), we conservatively resolve for NEW + ALL audiences
    // only. The cart re-asks per-customer once auth lands.
    // Phase AW-19 — all marketing resolvers evaluate daily windows
    // in the location timezone so an operator setting "Mon 14:00 UK"
    // matches UK clock-time, not server-UTC.
    const tz = location.timezone;
    const campaign = await this.pickStorefrontCampaign({
      brandId: menuBrandId,
      audiences: ["ALL", "NEW"],
      timezone: tz,
    });
    // Phase AW-19 — per-item promo map for PERCENT_OFF_ITEMS. Storefront
    // ProductCard reads this to strike through the original price and
    // show the discounted one. Cart math uses the discounted unitPrice.
    const itemPromos = await this.marketing.resolveItemPromos(
      menuBrandId,
      ["ALL", "NEW"],
      tz,
    );
    const bogo = await this.marketing.resolveBogo(
      menuBrandId,
      ["ALL", "NEW"],
      tz,
    );
    const freeDelivery = await this.marketing.resolveFreeDelivery(
      menuBrandId,
      ["ALL", "NEW"],
      tz,
    );
    const freeItemRaw = await this.marketing.resolveFreeItem(
      menuBrandId,
      ["ALL", "NEW"],
      tz,
    );
    // Phase AW-19 — resolve the actual itemIds that fall under any
    // excluded category, against THIS storefront's menu (categories
    // are per-menu, so we can't trust the operator-side category id
    // alone — we walk the served menu by category id AND by
    // category name as a fallback so a same-named category in a
    // republished menu still excludes correctly).
    let freeItem:
      | (typeof freeItemRaw & { excludedItemIds: string[] })
      | null = null;
    if (freeItemRaw) {
      const excludedSet = new Set<string>();
      if (freeItemRaw.excludedCategoryIds.length > 0 && menu) {
        const wantIds = new Set(freeItemRaw.excludedCategoryIds);
        // We don't have the source category names; fetch them so a
        // name-match fallback can rescue stale ids that point at a
        // since-republished menu.
        const sourceCats = await this.prisma.menuCategory.findMany({
          where: { id: { in: freeItemRaw.excludedCategoryIds } },
          select: { name: true },
        });
        const wantNames = new Set(
          sourceCats.map((c) => c.name.trim().toLowerCase()),
        );
        for (const cat of (menu as any).categories ?? []) {
          const idMatch = wantIds.has(cat.id);
          const nameMatch = wantNames.has(
            String(cat.name ?? "").trim().toLowerCase(),
          );
          if (!idMatch && !nameMatch) continue;
          for (const link of cat.items ?? []) {
            const id = link.itemId ?? link.item?.id;
            if (id) excludedSet.add(id);
          }
        }
      }
      freeItem = {
        ...freeItemRaw,
        excludedItemIds: Array.from(excludedSet),
      };
    }

    return {
      directConfig,
      deliveryZones,
      brandModifierGroups,
      campaign,
      itemPromos,
      bogo,
      freeDelivery,
      freeItem,
      location: locationView,
      brand: brandView,
      menu,
      isOpen: this.isCurrentlyOpen(effectiveHours as any, location.timezone),
      // Phase AW-15 — null when accepting orders; populated when the
      // operator hit Stop Taking Orders. extraPrepTime is non-null when
      // busy-mode is active (still accepting, just slower).
      closed,
      busy:
        pauseSnapshot.mode === "busy"
          ? {
              brandName:
                pauseSnapshot.brandName ??
                (brandView as any)?.name ??
                location.name,
              resumeAt: pauseSnapshot.resumeAt,
              reason: pauseSnapshot.reason,
              extraPrepTime: pauseSnapshot.extraPrepTime,
            }
          : null,
    };
  }

  async checkout(slug: string, dto: CheckoutDto, brandIdOverride?: string) {
    const location = await this.prisma.location.findFirst({
      where: { OR: [{ onlineOrderingSlug: slug }, { slug }, { id: slug }] },
      include: { brand: { select: { tenantId: true } } },
    });

    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }

    // Phase AW — when a brand is pinned via /brand/<slug>?brand=<id>,
    // resolve it so the Order gets tagged to the brand (drives the
    // brand column on the Orders board, brand logo + name on the
    // receipt header, and brand-level Stripe Connect resolution).
    // Skip if the override doesn't belong to this location — we'd
    // rather drop a malformed query param than create an order under
    // someone else's brand.
    let pinnedBrandId: string | null = null;
    let pinnedBrandHours: any = null;
    if (brandIdOverride) {
      const brandRow = await (this.prisma as any).brand.findUnique({
        where: { id: brandIdOverride },
        select: {
          id: true,
          tenantId: true,
          isSuspended: true,
          openingHours: true,
        },
      });
      if (
        brandRow &&
        !brandRow.isSuspended &&
        brandRow.tenantId === location.brand.tenantId
      ) {
        pinnedBrandId = brandRow.id;
        pinnedBrandHours = brandRow.openingHours ?? null;
      }
    }

    // Phase AW-30 — checkout guard uses brand hours when configured,
    // so a customer who got past the storefront banner ("brand says
    // open") can't be blocked by the location's stricter window.
    // Brand.openingHours defaults to {} which we treat as "not set".
    const brandHoursConfigured =
      pinnedBrandHours != null &&
      (Array.isArray(pinnedBrandHours)
        ? pinnedBrandHours.length > 0
        : Object.keys(pinnedBrandHours).length > 0);
    const checkoutHours = brandHoursConfigured
      ? pinnedBrandHours
      : location.openingHours;
    if (!this.isCurrentlyOpen(checkoutHours as any, location.timezone)) {
      throw new BadRequestException("Store is currently closed");
    }

    // Phase AW-15 — server-side defence against a customer reaching the
    // /checkout endpoint while the operator has the storefront paused
    // (banner bypass, stale tab, deep link, race during pause). Always
    // re-check the live state regardless of what the client thinks.
    const livePause = await this.pauses.isPaused({
      locationId: location.id,
      brandId: pinnedBrandId,
      channel: "ONLINE",
    });
    if (livePause.paused) {
      throw new BadRequestException(
        livePause.reason
          ? `Not accepting orders right now: ${livePause.reason}`
          : "This brand isn't accepting online orders right now",
      );
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

    // Phase AW-19 — re-resolve the marketing campaign server-side so a
    // tampered cart can't apply an offer they're not entitled to. We
    // resolve the customer's audience bucket now that we have their
    // customerAccountId (or treat guest checkouts as NEW). Discount
    // applies to subtotal only, never delivery/tax. Order.discount and
    // Order.total are rewritten to use the server-computed values.
    const campaignBrandId =
      pinnedBrandId ?? (location as any).brandId;
    let campaignDiscount = 0;
    try {
      const customerAudience = await this.marketing.resolveAudience({
        tenantId: location.brand.tenantId,
        customerAccountId: dto.customerAccountId ?? null,
      });
      const appliedCampaign = await this.pickStorefrontCampaign({
        brandId: campaignBrandId,
        audiences: ["ALL", customerAudience],
        timezone: location.timezone,
      });
      if (
        appliedCampaign &&
        (appliedCampaign.minOrder == null ||
          dto.subtotal >= appliedCampaign.minOrder)
      ) {
        if (appliedCampaign.percentageOff != null) {
          campaignDiscount =
            Math.round(dto.subtotal * appliedCampaign.percentageOff) / 100;
        } else if (appliedCampaign.amountOff != null) {
          campaignDiscount = Math.min(dto.subtotal, appliedCampaign.amountOff);
        }
      }
    } catch (err) {
      // Phase AW-19 — never fail checkout because campaign resolution
      // broke. Fall back to whatever the client already applied.
      this.logger.warn(
        `Campaign re-resolution failed for slug=${slug}: ${(err as Error).message}`,
      );
    }
    // Phase AW-19 — server-side enforcement of FREE_DELIVERY so a
    // tampered cart can't charge the customer if the campaign is
    // active. Resolution failures fall back to dto.deliveryFee.
    let serverDeliveryFee = dto.deliveryFee ?? 0;
    try {
      const fd = await this.marketing.resolveFreeDelivery(
        campaignBrandId,
        [
          "ALL",
          await this.marketing.resolveAudience({
            tenantId: location.brand.tenantId,
            customerAccountId: dto.customerAccountId ?? null,
          }),
        ],
        location.timezone,
      );
      if (fd && dto.fulfillmentType === "DELIVERY") serverDeliveryFee = 0;
    } catch (err) {
      this.logger.warn(
        `Free-delivery re-resolution failed for slug=${slug}: ${(err as Error).message}`,
      );
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const serverDiscount = round2(Math.max(dto.discount ?? 0, campaignDiscount));
    const serverTotal = round2(
      dto.subtotal -
        serverDiscount +
        (dto.taxAmount ?? 0) +
        serverDeliveryFee,
    );

    const order = await this.ordersService.create(
      {
        locationId: location.id,
        // Phase AW — pin the brand when the storefront URL carried
        // one. Falls through to whatever OrdersService.create derives
        // from the location's primary brand otherwise.
        brandId: pinnedBrandId ?? undefined,
        orderSource: "ONLINE",
        fulfillmentType: dto.fulfillmentType,
        customerInfo: dto.customerInfo,
        deliveryAddress: dto.deliveryAddress,
        items,
        subtotal: dto.subtotal,
        taxAmount: dto.taxAmount ?? 0,
        deliveryFee: serverDeliveryFee,
        discount: serverDiscount,
        total: serverTotal,
        specialInstructions: dto.specialInstructions,
        // Phase — thread the customer's chosen schedule through so the
        // order is actually saved as scheduled (was dropped here, which
        // made every scheduled storefront order show "ASAP").
        scheduledFor: (dto as any).scheduledFor ?? undefined,
        isScheduled: !!(dto as any).scheduledFor,
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
      // Phase AW — keep the brand pin on the Stripe-return URLs so the
      // post-payment storefront still renders the brand identity. The
      // confirmation page reads `?brand=<id>` and forwards it onto the
      // /order/<slug>?brand=… target it bounces to.
      const brandQs = pinnedBrandId
        ? `&brand=${encodeURIComponent(pinnedBrandId)}`
        : "";
      const successUrl = `${origin}/order/${slug}/confirmation?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}${brandQs}`;
      const cancelUrl = `${origin}/order/${slug}?canceledOrderId=${order.id}${brandQs}`;

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
    //   • paymentStatus so the "Processing your order…" screen knows
    //     whether the Stripe authorisation has landed yet
    //
    // Belt-and-braces for the Stripe webhook path: if paymentStatus
    // is still PENDING when the storefront polls, hit Stripe live to
    // see if the customer actually paid. This kicks in when the
    // operator's webhook endpoint isn't configured for Connected-
    // account events (direct charges fire there, not on platform
    // scope), which would otherwise leave the order stuck forever.
    const initial = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { paymentMethod: true, paymentStatus: true },
    });
    if (initial?.paymentMethod === "CARD" && initial.paymentStatus === "PENDING") {
      try {
        await this.payments.reconcileOrderPayment(orderId);
      } catch {
        /* best-effort — the underlying read below still returns
           whatever's in the DB so the polling loop keeps trying. */
      }
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        displayId: true,
        orderNumber: true,
        status: true,
        paymentMethod: true,
        paymentStatus: true,
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
        // Phase AR — surfaced so the standalone tracking page can
        // drive the "Order again" hand-off without an extra fetch.
        items: {
          select: {
            id: true,
            menuItemId: true,
            name: true,
            unitPrice: true,
            quantity: true,
            modifiers: true,
            notes: true,
          },
        },
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
  /**
   * Phase AW-19 — pick the best active campaign for the storefront.
   *
   * Returns null when nothing matches. When several campaigns qualify
   * (e.g. both ALL and NEW have one), we pick the one with the
   * highest percentageOff so the customer sees the friendliest
   * offer. Min-order gating is left to the cart math.
   */
  private async pickStorefrontCampaign(args: {
    brandId: string;
    audiences: Array<"ALL" | "NEW" | "RETURNING" | "LAPSED">;
    timezone?: string;
  }): Promise<{
    id: string;
    name: string;
    type: string;
    audience: string;
    percentageOff: number | null;
    amountOff: number | null;
    minOrder: number | null;
  } | null> {
    const rows = await this.marketing.resolveActiveForBrandChannel(
      args.brandId,
      "ONLINE",
      args.timezone,
    );
    if (!rows.length) return null;
    // Phase AW-19 — only storewide order-level types belong here.
    // PERCENT_OFF_ITEMS rows are delivered through `itemPromos` and
    // must not be applied to the whole basket.
    const STOREWIDE = new Set([
      "PERCENTAGE_OFF",
      "AMOUNT_OFF_ORDER",
      "HAPPY_HOUR",
    ]);
    const matching = rows.filter(
      (r: any) =>
        STOREWIDE.has(r.type) && args.audiences.includes(r.audience),
    );
    if (!matching.length) return null;
    // Pick the campaign with the bigger headline number: highest
    // percent wins over a smaller one; amount-off rows compare on
    // amountOff. Operators don't usually stack campaigns so the
    // choice is rarely contended.
    matching.sort(
      (a: any, b: any) =>
        Number(b.percentageOff ?? 0) - Number(a.percentageOff ?? 0) ||
        Number(b.amountOff ?? 0) - Number(a.amountOff ?? 0),
    );
    const c = matching[0];
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      audience: c.audience,
      percentageOff: c.percentageOff != null ? Number(c.percentageOff) : null,
      amountOff: c.amountOff != null ? Number(c.amountOff) : null,
      minOrder: c.minOrder != null ? Number(c.minOrder) : null,
    };
  }

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
      // Phase AW-30 — two shapes share this map. The Phase AN location
      // drawer saves `{ monday: { enabled, slots:[{from,to}] } }`; the
      // AW-16 brand drawer saves the flatter `{ monday: [{from,to}] }`.
      // Accept either.
      const slotsForKey = (key: string): Array<{ from?: string; to?: string }> => {
        const d = openingHours[key];
        if (!d) return [];
        if (Array.isArray(d)) return d;
        if (d.enabled === false) return [];
        return Array.isArray(d.slots) ? d.slots : [];
      };

      // Phase AW-30 — overnight slots ("from > to" means past
      // midnight). 09:00→02:00 keeps the shop open from 09:00 today
      // through 02:00 tomorrow, so at 01:30 the previous day's slot
      // is still active.
      const toMins = (s: string) => {
        const [h = 0, m = 0] = s.split(":").map(Number);
        return h * 60 + m;
      };
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const yesterdayIdx = (dayOfWeek + 6) % 7;

      for (const s of slotsForKey(keys[dayOfWeek] as string)) {
        if (!s.from || !s.to) continue;
        const from = toMins(s.from);
        const to = toMins(s.to);
        if (from < to) {
          if (nowMins >= from && nowMins < to) return true;
        } else if (from > to) {
          // Today's overnight slot — open from `from` until midnight.
          if (nowMins >= from) return true;
        }
      }
      for (const s of slotsForKey(keys[yesterdayIdx] as string)) {
        if (!s.from || !s.to) continue;
        const from = toMins(s.from);
        const to = toMins(s.to);
        // Yesterday's overnight slot spilling into today — open from
        // midnight until `to`.
        if (from > to && nowMins < to) return true;
      }
      return false;
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
