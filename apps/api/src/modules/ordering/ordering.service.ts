import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  currencyForCountry,
  itemAllowsFulfillment,
  resolveZone,
  serviceModeFor,
  usesTap,
  zoneMode,
  type ZoneLike,
} from "@orderhub/shared";
import { OrdersService } from "../orders/orders.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import { PaymentsService } from "../payments/payments.service";
import { TapService } from "../payments/tap.service";
import { MenuAvailabilityService } from "../inventory/menu-availability.service";
import { MenuAssignmentsService } from "../menus/menu-assignments.service";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../menus/variant-price-resolver.service";
import { resolveNestedModifierGroups } from "../menus/nested-modifier-groups";
import { PauseService } from "../pauses/pause.service";
import { MarketingService } from "../marketing/marketing.service";
import { DeliveryZonesService } from "../delivery-zones/delivery-zones.service";

export interface CheckoutItemDto {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  /**
   * Selected modifiers, flat across every nesting level. `depth` and `path`
   * describe where a selection sat ("Make It a Meal" → "Fries" → a dip) so
   * the kitchen ticket can indent it under the choice that opened it. They're
   * stored verbatim on OrderItem.modifiers and are absent on flat lines.
   */
  modifiers?: Array<{
    name: string;
    price: number;
    depth?: number;
    path?: string[];
    parentOptionId?: string | null;
  }>;
  notes?: string;
}

export interface CheckoutDto {
  idempotencyKey: string;
  fulfillmentType: "PICKUP" | "DELIVERY" | "DINE_IN";
  customerInfo: { name: string; phone?: string; email?: string };
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city: string;
    /** Optional outside the UK — the Gulf has no postcodes in everyday use. */
    postcode?: string;
    /** Gulf: the community the customer picked, e.g. "Dubai Marina". This is
     *  what prices the order there, so it is as load-bearing as postcode is
     *  in the UK. */
    area?: string;
    /** Carried straight through from the Places pick when there was one, so
     *  distance bands don't have to re-geocode a string we already resolved. */
    latitude?: number;
    longitude?: number;
  };
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
  /** Storefront "Send me offers by SMS" checkbox → SMS-marketing consent. */
  marketingConsent?: boolean;
  /**
   * Optional gratuity, in pounds. Goes to the RESTAURANT, not a courier —
   * it rides the order total into the brand's own Connect account like the
   * rest of the basket, so the shop keeps it whatever the delivery method.
   */
  tipAmount?: number;
  // Phase AP-8 — when set to "CARD", checkout() returns a Stripe Checkout
  // Session URL the storefront should redirect the browser to. Defaults
  // to "CASH" if absent so existing callers keep working.
  paymentMethod?: "CASH" | "CARD";
  /**
   * CARD orders only: pay on the page instead of on Stripe's hosted
   * checkout. checkout() returns a PaymentIntent clientSecret rather than
   * a checkoutUrl, which is what the Payment Element and the Apple/Google
   * Pay express buttons need.
   *
   * The secret is minted here, in the same call that creates the order,
   * on purpose: the caller proves it owns the order by being the one that
   * just placed it. A public route keyed on orderId would let anyone who
   * can guess an id mint a PaymentIntent against someone else's order.
   *
   * Absent/false keeps the redirect flow, so existing storefronts are
   * unaffected.
   */
  embedded?: boolean;
  // Phase AP-5 — when the storefront customer is signed in, the
  // CustomerAccount id is threaded through here so the Order can be
  // attributed to them for the "My Orders" page. Null/undefined
  // means guest checkout — order is still placed, just unlinked.
  customerAccountId?: string;
}

/**
 * A delivery order with a zero fee and no genuine FREE_DELIVERY campaign
 * behind it means the postcode didn't match any of the brand's zones — a
 * config gap or a lookup bug, not a real free delivery. Charging nothing in
 * that case is a silent revenue leak, and blocking the order outright is
 * worse for the customer. Fail safe by charging the brand's highest
 * configured zone fee instead — never free, never blocked.
 *
 * `zoneFees` should already be scoped to the resolved brand's active zones.
 * An empty list (nothing configured at all) leaves the fee untouched —
 * there is no "highest fee" to fall back to.
 */
export function resolveDeliveryFee(input: {
  fulfillmentType: "PICKUP" | "DELIVERY" | "DINE_IN";
  requestedFee: number | undefined;
  freeDeliveryApplied: boolean;
  zoneFees: number[];
}): number {
  const requested = input.requestedFee ?? 0;
  if (input.fulfillmentType !== "DELIVERY") return requested;
  if (input.freeDeliveryApplied) return 0;
  if (requested > 0) return requested;
  const highestZoneFee = input.zoneFees.reduce(
    (max, fee) => Math.max(max, fee),
    0,
  );
  return highestZoneFee > 0 ? highestZoneFee : requested;
}

/** What to do about delivery, given the zones that apply and what the customer
 *  told us.
 *
 *  Extracted from checkout() for the same reason deliveryZoneScope was: the
 *  earlier fix tested the max-of-fees maths but not the DECISION around it,
 *  and the decision is where the interesting rule now lives — area mode
 *  refuses, every other mode prices around a miss.
 *
 *  - REFUSE   the customer named an area this shop does not serve. The picker
 *             is built from the operator's own rows, so this is a genuine "we
 *             don't go there", not a typo to be generous about.
 *  - CHARGE   an area matched; that fee is authoritative. There is no postcode
 *             to cross-check a client-sent fee against in area mode, so the
 *             server prices it outright rather than only patching a zero.
 *  - FALLBACK postcode/radius: leave it to resolveDeliveryFee, which charges
 *             the highest configured fee rather than letting an order go out
 *             free. */
export function resolveZoneOutcome(
  zones: ZoneLike[],
  customer: { postcode?: string; area?: string; distanceMiles?: number | null },
):
  | { kind: "REFUSE"; area?: string }
  | { kind: "CHARGE"; fee: number }
  | { kind: "FALLBACK" } {
  const mode = zoneMode(zones);

  if (mode === "AREA") {
    const match = resolveZone(zones, { area: customer.area });
    if (!match.matched) return { kind: "REFUSE", area: customer.area };
    return { kind: "CHARGE", fee: match.fee };
  }

  if (mode === "RADIUS") {
    // Also authoritative, and for the same reason: the browser cannot measure
    // distance, so whatever fee it sent is a guess. It used to be accepted as
    // given, which meant every radius shop charged its TOP band to everyone,
    // including the customer across the road.
    const match = resolveZone(zones, { distanceMiles: customer.distanceMiles });
    if (!match.matched) return { kind: "FALLBACK" };
    return { kind: "CHARGE", fee: match.fee };
  }

  return { kind: "FALLBACK" };
}

/** Every delivery zone that could apply at one shop.
 *
 *  DeliveryZone is scoped to a LOCATION or to a BRAND, and a location can
 *  serve several brands, so a brand-only lookup misses zones that plainly do
 *  apply there. Order #JWDBH (pizza uno pelton) shipped with £0 delivery
 *  because of that: the checkout carried no pinned brand, so the brand fell
 *  back to the location's default, that brand had no zones, and the fallback
 *  found nothing to charge.
 *
 *  Kept separate from resolveDeliveryFee so the SCOPE is testable on its own —
 *  the earlier fix tested the max-of-fees maths but not which fees got
 *  collected, which is where this bug actually lived. */
export function deliveryZoneScope(input: {
  locationId: string;
  brandId?: string | null;
}) {
  return {
    isActive: true,
    OR: [
      { locationId: input.locationId },
      ...(input.brandId ? [{ brandId: input.brandId }] : []),
      { brand: { locations: { some: { id: input.locationId } } } },
    ],
  };
}

/** Which brand an un-pinned order belongs to.
 *
 *  Two fields describe a location's brand and they can disagree:
 *  Location.brandId (a required FK, set at creation) and
 *  Brand.primaryLocationId (what the location's Brands drawer lists). Deleting
 *  a location nulls the second but never repoints the first, so a shop can end
 *  up with Location.brandId still aimed at an orphaned brand while the brand
 *  actually trading there is a different row. Order #JWDBH printed "Order Hub"
 *  as the shop name for exactly that reason, and looked up delivery zones
 *  against a brand that has none.
 *
 *  Deliberately conservative: the stored brand wins unless it is genuinely
 *  orphaned AND exactly one brand operates at the location. With two or more
 *  there is no non-arbitrary answer, and guessing would mis-attribute revenue,
 *  so it keeps the existing behaviour and the receipt stays wrong rather than
 *  becoming wrong in a new and less traceable way. */
export function resolveUnpinnedBrandId(input: {
  locationBrandId: string;
  locationBrandIsOrphan: boolean;
  operatingBrandIds: string[];
}): string {
  if (!input.locationBrandIsOrphan) return input.locationBrandId;
  if (input.operatingBrandIds.length === 1) return input.operatingBrandIds[0]!;
  return input.locationBrandId;
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
    // Phase BA — serving-assignment resolver (assignment-first menu pick).
    private readonly menuAssignments: MenuAssignmentsService,
    // Phase BF — variant-menu publish (price from a different menu's variant).
    private readonly variantResolver: VariantPriceResolverService,
    // Phase AW-15 — resolve current pause state so the storefront can
    // render the "currently not accepting orders" banner and checkout
    // can refuse to land a new Order against a paused brand.
    private readonly pauses: PauseService,
    // Phase AW-19 — pick + apply the best active marketing campaign at
    // storefront load + checkout time. Audience bucket is resolved
    // per-customer so a NEW customer's "first order 20% off" only
    // fires for actual newcomers.
    private readonly marketing: MarketingService,
    private readonly deliveryZones: DeliveryZonesService,
    private readonly tap: TapService,
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
            topSellerItemIds: true,
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
            topSellerItemIds: true,
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

    // Phase BA — assignment-first: the publish flow writes one
    // MenuChannelAssignment per (location, ONLINE, brand); resolve that
    // before the legacy cascades so multi-location menus serve everywhere
    // they're published. Brand-pinned storefronts resolve their brand's
    // slot; unpinned ones prefer the location's primary brand. Legacy
    // cascades below are untouched so un-republished locations keep
    // working exactly as before.
    const assignedMenuId = await this.menuAssignments.resolveAssignedMenuId(
      brandIdOverride
        ? { locationId: location.id, channel: "ONLINE", brandId: menuBrandId }
        : {
            locationId: location.id,
            channel: "ONLINE",
            preferBrandId: location.brandId,
          },
    );
    const assignedMenu = assignedMenuId
      ? await this.prisma.menu.findFirst({
          where: { id: assignedMenuId },
          include: menuInclude,
        })
      : null;

    const menu =
      assignedMenu ??
      (brandIdOverride
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
          })));

    // Phase BF — variant-menu publish. Only set when the brand's Channels
    // settings name a source menu for ONLINE; null otherwise, in which
    // case every price stays exactly as stored on the menu (unchanged
    // behaviour). Mutates the resolved menu's item/SKU/option prices in
    // place before it's returned to the customer.
    if (menu) {
      const variantMap = await this.variantResolver.forBrandChannel({
        brandId: menuBrandId,
        channel: "ONLINE",
      });
      if (variantMap) this.applyVariantPriceOverrides(menu, variantMap);
    }

    // "Top sellers" — the items the operator pinned above the menu.
    //
    // Resolved from the live menu rather than fetched separately, so a pick
    // that has since been removed from the menu, 86'd or hidden simply stops
    // appearing instead of rendering a row the customer can't order. Kept in
    // the operator's chosen order, which is the whole point of the feature.
    const topSellerSource: any = overrideBrand ?? (location as any).brand;
    const topSellerIds: string[] = Array.isArray(topSellerSource?.topSellerItemIds)
      ? (topSellerSource.topSellerItemIds as string[])
      : [];
    const topSellers: any[] = [];
    if (topSellerIds.length && menu) {
      const onMenu = new Map<string, any>();
      for (const cat of (menu as any).categories ?? []) {
        for (const link of cat.items ?? []) {
          if (link?.item?.id) onMenu.set(link.item.id, link.item);
        }
      }
      for (const id of topSellerIds) {
        const item = onMenu.get(id);
        if (item) topSellers.push(item);
      }
    }

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
        showItemImages: true,
      };
    // Online ordering delivery charges are configured in BRAND settings
    // (Brand → "Delivery postcodes & charges"), NOT the POS/location
    // delivery zones. Resolve zones from the pinned brand (or the
    // location's primary brand when the storefront URL carried no
    // ?brand=). We deliberately do NOT fall back to location-scoped
    // (POS) zones — POS and online ordering keep separate postcode
    // charges, so an operator's till pricing never leaks onto the
    // storefront. A brand with no zones configured simply has no
    // postcode charges online until the operator sets them in brand
    // settings.
    const zoneBrandId = overrideBrand?.id ?? location.brandId;
    const deliveryZones = zoneBrandId
      ? await this.prisma.deliveryZone.findMany({
          where: { brandId: zoneBrandId, isActive: true },
          // The whole row shape, not just prefixes: the storefront runs the
          // same shared resolver the server does, and it can't pick a mode it
          // can't see. Sending prefixes only is what made a brand on distance
          // bands white-screen the storefront — every row arrived with a null
          // prefix and the client called .toUpperCase() on it.
          select: {
            id: true,
            postcodePrefix: true,
            areaName: true,
            maxDistanceMiles: true,
            fee: true,
            minOrderValue: true,
          },
        })
      : [];

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
        // Phase BA — this location's own 86s apply on top of global ones.
        location.id,
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

    // A multi-SKU product's per-size modifier groups can belong to a
    // DIFFERENT brand than the menu's brand (multi-brand catalogs), so the
    // brand-scoped query above misses them and the storefront modal shows no
    // modifiers for that size. Resolve any SKU-referenced groups by id and
    // merge them in (brand-drift safe — same fix the dashboard uses).
    const skuGroupIds = new Set<string>();
    for (const cat of (menu as any)?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const skus = link?.item?.productSkus;
        if (Array.isArray(skus)) {
          for (const s of skus)
            for (const gid of s?.modifierGroups ?? [])
              if (typeof gid === "string" && gid) skuGroupIds.add(gid);
        }
      }
    }
    const haveIds = new Set(brandModifierGroups.map((g) => g.id));
    const missingIds = [...skuGroupIds].filter((id) => !haveIds.has(id));
    if (missingIds.length) {
      const extra = await this.prisma.modifierGroup.findMany({
        where: { id: { in: missingIds } },
        include: {
          options: {
            where: { isAvailable: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
      brandModifierGroups.push(...extra);
    }

    // Fold in modifiers attached via ModifierOption.modifierGroupIds[].
    //
    // The `options` relation above is the FK-primary set only, so every
    // modifier added through the catalogue's "Add Existing" button was
    // invisible online — a group would show four toppings when it holds a
    // dozen. Same rule as MenusService.mergeArrayAttachedOptions, kept local
    // because the storefront additionally has to hide 86'd modifiers.
    //
    // The item-level groups get the same treatment: a flat (non-sized)
    // product renders straight off item.modifierGroupLinks[].group.options,
    // which has the identical FK-only blind spot.
    const linkedGroups: any[] = [];
    for (const cat of (menu as any)?.categories ?? []) {
      for (const link of cat.items ?? []) {
        for (const gl of link?.item?.modifierGroupLinks ?? []) {
          if (gl?.group?.options) linkedGroups.push(gl.group);
        }
      }
    }
    await this.foldArrayAttachedOptions(
      [...brandModifierGroups, ...linkedGroups],
      menuBrandId,
    );

    // Phase BN — groups that hang off an OPTION rather than a product
    // ("Make It a Meal" opening a sides and a drinks picker). They're
    // unreachable from item.modifierGroupLinks at any include depth, so
    // resolve them by id and merge them into the same catalogue the modal
    // already indexes by id. Runs AFTER the fold above so array-attached
    // options are present and their own nested groups get followed too.
    const nestedTenant = await this.prisma.brand.findUnique({
      where: { id: menuBrandId },
      select: { tenantId: true },
    });
    if (nestedTenant) {
      const nestedGroups = await resolveNestedModifierGroups(
        this.prisma,
        [...brandModifierGroups, ...linkedGroups],
        { tenantId: nestedTenant.tenantId, onlyAvailable: true },
      );
      if (nestedGroups.length) {
        // Nested groups have the same FK-only blind spot as every other
        // group, so they need the fold as well or a nested picker shows
        // four sauces when the group holds a dozen.
        await this.foldArrayAttachedOptions(nestedGroups, menuBrandId);
        const have = new Set(brandModifierGroups.map((g) => g.id));
        for (const g of nestedGroups) {
          if (!have.has(g.id)) brandModifierGroups.push(g);
        }
      }
    }

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
      // Currency is location-only on purpose — it follows the till and the
      // bank account, not the brand, so a brand trading in two countries does
      // not force one currency onto both shops. The storefront needs it to
      // price anything at all outside the UK.
      currency: (location as any).currency ?? currencyForCountry(location.country),
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
      // Phase AP-8 / AW — application-fee config. The storefront cart's
      // "Service charge" line reads from here, so this MUST answer
      // "which fee config applies" identically to computeFeeBreakdownPence
      // on the payment side. It didn't: `??` only falls through on null,
      // so a brand explicitly set to "none" over a location that charges a
      // fixed fee showed the customer no service charge and then took it
      // anyway — cart said £1.80, card was debited £2.30.
      //
      // The payment side's rule is "brand wins unless it's none". Same rule
      // here, and both fields come from the SAME record, so a brand mode
      // can never be paired with a location amount.
      ...(() => {
        const source =
          b?.applicationFeeMode && b.applicationFeeMode !== "none"
            ? b
            : location;
        return {
          applicationFeeMode: source.applicationFeeMode,
          applicationFeeFixedAmount:
            (source as any).applicationFeeFixedAmount != null
              ? Number((source as any).applicationFeeFixedAmount)
              : null,
        };
      })(),
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

    // Re-anchor item-based promos (BOGO / free-item / per-item %) onto the
    // SERVED menu. These campaigns store the MenuItem ids the operator
    // picked when the campaign was built; if the storefront later serves a
    // different menu row — a republish, or a per-location assignment
    // (Phase BA) — those ids don't exist in the served menu, so the client
    // can't match them and the promo silently stops applying. Map the
    // stored ids to the served menu's equivalent items by a stable key
    // (externalId, then normalised name) so promos survive menu changes.
    const anchor = await this.anchorPromoItemsToServedMenu(menu, [
      ...(bogo?.triggerItemIds ?? []),
      ...(freeItem?.freeItemIds ?? []),
      ...Object.keys(itemPromos ?? {}),
    ]);
    const remapIds = (ids: string[]): string[] =>
      Array.from(
        new Set(
          ids.map((id) => anchor.get(id)).filter((x): x is string => !!x),
        ),
      );
    if (bogo) bogo.triggerItemIds = remapIds(bogo.triggerItemIds);
    if (freeItem) freeItem.freeItemIds = remapIds(freeItem.freeItemIds);
    const itemPromosAnchored: Record<string, any> = {};
    for (const [id, v] of Object.entries(itemPromos ?? {})) {
      const served = anchor.get(id);
      if (served) itemPromosAnchored[served] = v;
    }

    // "Order on WhatsApp" CTA — surface the location's WhatsApp business
    // number ONLY when the WhatsApp channel is both configured AND live:
    // an Integration row (platform WHATSAPP) with status ACTIVE and a
    // customer-facing display number. WhatsApp is per-location, so a
    // kitchen running several brands shares one number. displayPhoneNumber
    // is E.164 (e.g. "+447…"); the storefront strips it to a wa.me link.
    let whatsapp: { enabled: boolean; displayPhoneNumber: string } | null =
      null;
    try {
      const waInteg = await (this.prisma as any).integration.findUnique({
        where: {
          locationId_platform: {
            locationId: location.id,
            platform: "WHATSAPP",
          },
        },
        select: { status: true, settings: true },
      });
      const waNumber =
        waInteg?.status === "ACTIVE"
          ? String((waInteg.settings as any)?.displayPhoneNumber ?? "").trim()
          : "";
      if (waNumber) whatsapp = { enabled: true, displayPhoneNumber: waNumber };
    } catch {
      // Never fail the storefront over the optional WhatsApp CTA.
      whatsapp = null;
    }

    return {
      directConfig,
      deliveryZones,
      brandModifierGroups,
      topSellers,
      campaign,
      itemPromos: itemPromosAnchored,
      bogo,
      freeDelivery,
      freeItem,
      whatsapp,
      location: dedupeLogo(locationView, brandView),
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

  /**
   * Add each group's array-attached modifiers to its `options`, in place.
   *
   * A ModifierOption belongs to one group by FK but can be attached to any
   * number more through `modifierGroupIds[]` — that array is what the
   * catalogue's "Add Existing" button writes. Reading `options` alone returns
   * the FK-primary set, so those attachments simply never reached the
   * customer.
   *
   * Scoped by TENANT rather than brand: "Add Existing" is allowed to pull a
   * modifier owned by another brand of the same tenant, and brand-scoping
   * silently drops exactly those. 86'd modifiers stay hidden.
   */
  private async foldArrayAttachedOptions(
    groups: Array<{ id: string; options: any[] }>,
    brandId: string,
  ) {
    if (groups.length === 0) return;
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { tenantId: true },
    });
    if (!brand) return;
    const groupIds = new Set(groups.map((g) => g.id));
    const attached = await this.prisma.modifierOption.findMany({
      where: {
        isAvailable: true,
        group: { brand: { tenantId: brand.tenantId } },
        modifierGroupIds: { hasSome: Array.from(groupIds) },
      },
      orderBy: { sortOrder: "asc" },
    });
    if (attached.length === 0) return;

    // One modifier can be attached to several groups, so bucket per group.
    const byGroup = new Map<string, typeof attached>();
    for (const opt of attached) {
      for (const gid of opt.modifierGroupIds ?? []) {
        if (!groupIds.has(gid)) continue;
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid)!.push(opt);
      }
    }
    for (const g of groups) {
      const extra = byGroup.get(g.id);
      if (!extra?.length) continue;
      // A modifier can be both FK-primary and array-listed on the same group.
      const seen = new Set(g.options.map((o: any) => o.id));
      g.options = [...g.options, ...extra.filter((o) => !seen.has(o.id))];
    }
  }

  /**
   * Refuse a basket containing something the shop does not sell this way.
   *
   * Named in the error, because "your order could not be placed" at the
   * payment step is the worst possible time to be vague — the customer has to
   * know which item to remove.
   */
  private async assertItemsAllowFulfillment(
    menuItemIds: string[],
    fulfillmentType: string | null | undefined,
  ): Promise<void> {
    const ids = [...new Set(menuItemIds.filter(Boolean))];
    if (!ids.length) return;

    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        availableCollection: true,
        availableDelivery: true,
        availableDineIn: true,
      },
    });

    const blocked = items.filter(
      (item) => !itemAllowsFulfillment(item, fulfillmentType),
    );
    if (!blocked.length) return;

    const mode = serviceModeFor(fulfillmentType);
    const how =
      mode === "DELIVERY"
        ? "delivery"
        : mode === "DINE_IN"
          ? "dine-in"
          : "collection";
    throw new BadRequestException(
      blocked.length === 1
        ? `${blocked[0]!.name} isn't available for ${how}. Please remove it or change how you'd like your order.`
        : `These aren't available for ${how}: ${blocked
            .map((b) => b.name)
            .join(", ")}. Please remove them or change how you'd like your order.`,
    );
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
      if (usesTap(location.country)) {
        // A Gulf shop has no Stripe Connect account and never will — Stripe's
        // own UAE rules forbid the direct-charge model this storefront uses.
        // Its gate is a Tap destination instead; TapService checks the brand's
        // and says so specifically, so don't pre-empt it with a vaguer message
        // here. All this needs to catch is Tap not being wired up at all.
        if (!this.tap.configured()) {
          throw new BadRequestException(
            "This restaurant hasn't set up card payments yet. Please choose Cash, or contact the restaurant.",
          );
        }
      } else {
        // Resolved WITH the pinned brand, matching what the payment call
        // below does. Without it a brand using the brand-level acct_
        // escape hatch fails this gate and is told the shop takes no
        // cards, even though the charge it's guarding would have gone
        // through. Passing the brand can only widen what's accepted here.
        const connect = await this.payments.resolveConnectAccount(
          location.brand.tenantId,
          location.id,
          pinnedBrandId ?? null,
        );
        if (!connect) {
          throw new BadRequestException(
            "This restaurant hasn't set up card payments yet. Please choose Cash, or contact the restaurant.",
          );
        }
      }
    }

    // Service-mode enforcement.
    //
    // The storefront already hides these, but hiding is not enforcing: the
    // cart survives a fulfillment switch, a stale tab keeps the old menu, and
    // the payload is client-supplied. If a shop says a 20" sharing pizza does
    // not go on a moped, the checkout has to be where that actually holds.
    await this.assertItemsAllowFulfillment(
      dto.items.map((i) => i.menuItemId),
      dto.fulfillmentType,
    );

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
    // No ?brand= on the checkout — fall back to the location's brand, but
    // only after checking that field still points somewhere real. See
    // resolveUnpinnedBrandId: a deleted location can leave Location.brandId
    // aimed at an orphaned brand, which is how #JWDBH printed the wrong shop
    // name and found no delivery zones.
    let campaignBrandId: string = pinnedBrandId ?? (location as any).brandId;
    if (!pinnedBrandId) {
      try {
        const [stored, operating] = await Promise.all([
          this.prisma.brand.findUnique({
            where: { id: (location as any).brandId },
            select: { primaryLocationId: true, deletedAt: true },
          }),
          this.prisma.brand.findMany({
            where: {
              primaryLocationId: location.id,
              deletedAt: null,
            },
            select: { id: true },
          }),
        ]);
        const resolved = resolveUnpinnedBrandId({
          locationBrandId: (location as any).brandId,
          locationBrandIsOrphan: !stored || !!stored.deletedAt || !stored.primaryLocationId,
          operatingBrandIds: operating.map((b) => b.id),
        });
        if (resolved !== campaignBrandId) {
          this.logger.warn(
            `Location ${location.id} has brandId pointing at an orphaned brand; attributing this order to ${resolved} instead`,
          );
          campaignBrandId = resolved;
        }
      } catch (err) {
        this.logger.warn(
          `Unpinned brand resolution failed for slug=${slug}: ${(err as Error).message}`,
        );
      }
    }
    let campaignDiscount = 0;
    // Phase MK-INSIGHTS — remember which campaigns actually applied so we
    // can attribute the order to them after it's created (drives the
    // Marketing page's Sales/Orders/New-customers insights). isNewCustomer
    // is the audience bucket resolved from the customer's order history.
    let isNewCustomer = false;
    let customerAudience: "ALL" | "NEW" | "RETURNING" | "LAPSED" = "ALL";
    let appliedDiscountCampaign: { id: string } | null = null;
    let appliedFreeDeliveryCampaign: { campaignId: string } | null = null;
    try {
      customerAudience = await this.marketing.resolveAudience({
        tenantId: location.brand.tenantId,
        customerAccountId: dto.customerAccountId ?? null,
      });
      isNewCustomer = customerAudience === "NEW";
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
        if (campaignDiscount > 0) {
          appliedDiscountCampaign = { id: appliedCampaign.id };
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
        ["ALL", customerAudience as any],
        location.timezone,
      );
      if (fd && dto.fulfillmentType === "DELIVERY") {
        serverDeliveryFee = 0;
        appliedFreeDeliveryCampaign = { campaignId: fd.campaignId };
      }
    } catch (err) {
      this.logger.warn(
        `Free-delivery re-resolution failed for slug=${slug}: ${(err as Error).message}`,
      );
    }
    // See resolveDeliveryFee — a delivery order can never end up charged
    // £0 unless a genuine FREE_DELIVERY campaign actually applied (the
    // pizza-uno-pelton #MJBYC incident was exactly this: no zone match,
    // fee silently stayed 0).
    if (dto.fulfillmentType === "DELIVERY") {
      try {
        // Widened deliberately. DeliveryZone can be scoped to a LOCATION
        // or to a BRAND, and a location can serve several brands, so
        // looking only at campaignBrandId misses zones that plainly do
        // apply at this shop. Order #JWDBH (pizza uno pelton) went out with
        // £0 delivery for exactly that reason: the checkout carried no
        // pinned brand, campaignBrandId fell back to the location's default
        // brand, that brand has no zones of its own, and the earlier
        // brand-only fallback therefore found nothing to charge.
        const zones = await this.prisma.deliveryZone.findMany({
          where: deliveryZoneScope({
            locationId: location.id,
            brandId: campaignBrandId,
          }),
          select: {
            id: true,
            fee: true,
            minOrderValue: true,
            postcodePrefix: true,
            areaName: true,
            maxDistanceMiles: true,
          },
        });

        // Measure only for distance bands — a postcode or area shop must not
        // pay for a geocode whose answer it then ignores.
        const distanceMiles =
          zoneMode(zones as any) === "RADIUS"
            ? await this.deliveryZones.distanceMilesFor(
                location.brand.tenantId,
                { locationId: location.id },
                {
                  lat: dto.deliveryAddress?.latitude,
                  lng: dto.deliveryAddress?.longitude,
                  postcode: dto.deliveryAddress?.postcode,
                  area: dto.deliveryAddress?.area,
                },
              )
            : null;
        const outcome = resolveZoneOutcome(zones as any, {
          area: dto.deliveryAddress?.area,
          distanceMiles,
        });
        if (outcome.kind === "REFUSE") {
          // The one case that blocks the order instead of pricing around it.
          // Free delivery wins on the money but never on whether we deliver
          // at all, so this sits outside the fee logic entirely.
          throw new BadRequestException(
            outcome.area
              ? `Sorry, we don't deliver to ${outcome.area}.`
              : "Please choose your delivery area.",
          );
        }
        if (outcome.kind === "CHARGE") {
          if (!appliedFreeDeliveryCampaign) serverDeliveryFee = outcome.fee;
        } else if (serverDeliveryFee <= 0) {
          // See resolveDeliveryFee — a delivery order can never end up
          // charged £0 unless a genuine FREE_DELIVERY campaign actually
          // applied (the pizza-uno-pelton #MJBYC incident was exactly this:
          // no zone match, fee silently stayed 0).
          //
          // "Highest fee from the postcodes available at that location" is
          // the rule the operator asked for: a postcode we don't recognise
          // is a config gap, and a shop losing the fee is worse than a
          // customer paying the top rate.
          const fallbackFee = resolveDeliveryFee({
            fulfillmentType: dto.fulfillmentType,
            requestedFee: serverDeliveryFee,
            freeDeliveryApplied: !!appliedFreeDeliveryCampaign,
            zoneFees: zones.map((z) => Number(z.fee)),
          });
          if (fallbackFee !== serverDeliveryFee) {
            this.logger.warn(
              `Delivery fee fallback: no zone match for slug=${slug}, charging highest configured fee (${fallbackFee}) instead of 0`,
            );
            serverDeliveryFee = fallbackFee;
          }
        }
      } catch (err) {
        // A refusal is a decision, not a failure — it must not be swallowed
        // by the catch that exists to stop lookup errors from killing
        // checkout.
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(
          `Delivery fee lookup failed for slug=${slug}: ${(err as Error).message}`,
        );
      }
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const serverDiscount = round2(Math.max(dto.discount ?? 0, campaignDiscount));
    // Tip is customer-set, so it's an untrusted number that raises the
    // charge. Floor at zero, and cap it against the basket rather than
    // accepting anything: a fat-fingered or tampered value should fail
    // safe at a generous ceiling, not bill someone hundreds.
    const goods = round2(dto.subtotal - serverDiscount + serverDeliveryFee);
    const tipCeiling = round2(Math.max(goods * 2, 50));
    const serverTip = round2(
      Math.min(Math.max(Number(dto.tipAmount ?? 0) || 0, 0), tipCeiling),
    );
    const serverTotal = round2(
      dto.subtotal -
        serverDiscount +
        (dto.taxAmount ?? 0) +
        serverDeliveryFee +
        serverTip,
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
        tipAmount: serverTip,
        specialInstructions: dto.specialInstructions,
        // Phase — thread the customer's chosen schedule through so the
        // order is actually saved as scheduled (was dropped here, which
        // made every scheduled storefront order show "ASAP").
        scheduledFor: (dto as any).scheduledFor ?? undefined,
        isScheduled: !!(dto as any).scheduledFor,
        idempotencyKey: dto.idempotencyKey,
        // Storefront SMS-marketing consent → captured on the resulting Order
        // via OrdersService.create's marketing.consent event.
        marketingConsent: dto.marketingConsent,
        paymentMethod: dto.paymentMethod ?? "CASH",
        paymentStatus: dto.paymentMethod === "CARD" ? "PENDING" : "PENDING",
        // Phase AP-5 — attribute the order to the signed-in customer
        // so it shows up on their My Orders page. Guest checkouts
        // pass undefined, which OrdersService.create treats as null.
        customerAccountId: dto.customerAccountId,
      } as any,
      location.brand.tenantId,
    );

    // Phase MK-INSIGHTS — attribute the order to whichever campaigns
    // actually applied, so the Marketing page can report real
    // Sales/Orders/New-customers per campaign. Best-effort: a failure here
    // must never break a placed order. discountAmount for free delivery is
    // 0 (it zeroed the delivery fee, which isn't part of Order.discount).
    void this.recordCampaignRedemptions({
      order,
      brandId: campaignBrandId,
      tenantId: location.brand.tenantId,
      customerAccountId: dto.customerAccountId ?? null,
      isNewCustomer,
      discountCampaignId: appliedDiscountCampaign?.id ?? null,
      discountAmount: serverDiscount,
      freeDeliveryCampaignId: appliedFreeDeliveryCampaign?.campaignId ?? null,
    }).catch((err) =>
      this.logger.warn(
        `Campaign redemption recording failed for order ${order.id}: ${(err as Error).message}`,
      ),
    );

    // Phase AP-8 — cash orders flow straight to the staff Orders board
    // as today. Card orders, on the other hand, need the customer to
    // complete payment through Stripe Checkout *first*; we return the
    // hosted-checkout URL for the storefront to redirect to. The order
    // joins the staff board only once the Stripe webhook reports
    // authorization (payment_intent.amount_capturable_updated).
    if (dto.paymentMethod === "CARD") {
      const origin0 = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
      const brandQs0 = pinnedBrandId ? `&brand=${encodeURIComponent(pinnedBrandId)}` : "";
      if (usesTap(location.country)) {
        // Tap is hosted-only here, including when the storefront asked for
        // the embedded flow. `src_all` renders Tap's own page with every
        // method the merchant has enabled — KNET, mada, BENEFIT, Apple Pay —
        // and each carries its own redirect and 3-D Secure step that an
        // embedded card field cannot host. Returning a checkoutUrl for an
        // `embedded: true` request is deliberate: the storefront already
        // knows how to redirect, and half a payment sheet is worse than a
        // page change.
        const { redirectUrl } = await this.tap.createCharge({
          tenantId: location.brand.tenantId,
          orderId: order.id,
          redirectUrl: `${origin0}/order/${slug}/confirmation?orderId=${order.id}${brandQs0}`,
          // Tap posts the settled charge here. Must be publicly reachable —
          // the money is not marked received anywhere else.
          webhookUrl: `${(process.env.API_URL ?? "").replace(/\/+$/, "")}/v1/payments/tap/webhook`,
          customer: {
            firstName: dto.customerInfo.name?.split(/\s+/)[0] ?? "Customer",
            lastName: dto.customerInfo.name?.split(/\s+/).slice(1).join(" ") || undefined,
            email: dto.customerInfo.email,
            phone: dto.customerInfo.phone,
          },
        });
        return { ...order, checkoutUrl: redirectUrl } as any;
      }

      // Embedded — the customer pays on our page (Payment Element /
      // Apple Pay / Google Pay), so there's nowhere to redirect to and
      // the client needs a PaymentIntent secret instead of a URL.
      //
      // Unlike the hosted path this captures immediately, so the order
      // reaches the board via payment_intent.succeeded as PAID rather
      // than waiting on an authorisation staff have to Accept. Rejecting
      // one is therefore a refund, not a lapsed hold.
      if (dto.embedded) {
        const { clientSecret, amountPence, stripeAccountId } =
          await this.payments.createStorefrontPaymentIntent({
            tenantId: location.brand.tenantId,
            orderId: order.id,
          });
        // stripeAccountId is not decoration: this is a direct charge on the
        // restaurant's account, so the browser has to construct Stripe.js
        // with it or the secret won't confirm.
        return { ...order, clientSecret, amountPence, stripeAccountId } as any;
      }

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
      select: {
        paymentMethod: true,
        paymentStatus: true,
        location: { select: { country: true } },
      },
    });
    if (initial?.paymentMethod === "CARD" && initial.paymentStatus === "PENDING") {
      try {
        // Same belt-and-braces on either provider, for the same reason: a
        // customer redirected back before the webhook lands, or a webhook
        // that never lands, must not leave a paid order sitting unpaid.
        if (usesTap((initial as any).location?.country)) {
          await this.tap.reconcileOrder(orderId);
        } else {
          await this.payments.reconcileOrderPayment(orderId);
        }
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
        // Phase AX-4 — live delivery tracking: destination + the assigned
        // driver's name/phone and last known GPS so the customer can watch
        // the driver approach, call them, or chat.
        deliveryLat: true,
        deliveryLng: true,
        driverAssignment: {
          select: {
            status: true,
            driver: {
              select: {
                firstName: true,
                phone: true,
                presence: { select: { lat: true, lng: true, lastPingAt: true, status: true } },
              },
            },
          },
        },
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

    // Shape a compact tracking summary; only expose the driver while the order
    // is actually out for delivery (not before pickup or after completion).
    const a = order.driverAssignment;
    const live = order.status === "OUT_FOR_DELIVERY" || order.status === "RIDER_ARRIVED";
    const driver =
      live && a?.driver
        ? {
            name: a.driver.firstName,
            phone: a.driver.phone,
            lat: a.driver.presence?.lat ?? null,
            lng: a.driver.presence?.lng ?? null,
            lastPingAt: a.driver.presence?.lastPingAt
              ? a.driver.presence.lastPingAt.toISOString()
              : null,
          }
        : null;
    const { driverAssignment: _ignored, ...rest } = order;
    return {
      ...rest,
      destination:
        order.deliveryLat != null && order.deliveryLng != null
          ? { lat: order.deliveryLat, lng: order.deliveryLng }
          : null,
      driver,
    };
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
  // Phase MK-INSIGHTS — write one campaign_redemptions row per campaign
  // that applied to a placed order. Idempotent on (orderId, campaignId) so
  // a retry can't double-count; also bumps the denormalised
  // redemptionCount used for the max-redemptions cap. Best-effort — the
  // caller swallows failures so an insight write never breaks checkout.
  private async recordCampaignRedemptions(args: {
    order: { id: string; total?: any };
    brandId: string;
    tenantId: string;
    customerAccountId: string | null;
    isNewCustomer: boolean;
    discountCampaignId: string | null;
    discountAmount: number;
    freeDeliveryCampaignId: string | null;
  }): Promise<void> {
    const orderTotal = Number(args.order.total ?? 0);
    const targets: Array<{ campaignId: string; discount: number }> = [];
    if (args.discountCampaignId) {
      targets.push({
        campaignId: args.discountCampaignId,
        discount: args.discountAmount,
      });
    }
    if (
      args.freeDeliveryCampaignId &&
      args.freeDeliveryCampaignId !== args.discountCampaignId
    ) {
      // Free delivery discounts the delivery fee, which isn't part of
      // Order.discount, so its attributed discountAmount is 0.
      targets.push({ campaignId: args.freeDeliveryCampaignId, discount: 0 });
    }
    for (const t of targets) {
      try {
        await (this.prisma as any).campaignRedemption.create({
          data: {
            tenantId: args.tenantId,
            campaignId: t.campaignId,
            brandId: args.brandId,
            orderId: args.order.id,
            channel: "ONLINE",
            customerAccountId: args.customerAccountId,
            isNewCustomer: args.isNewCustomer,
            discountAmount: t.discount,
            orderTotal,
          },
        });
        await (this.prisma as any).marketingCampaign.update({
          where: { id: t.campaignId },
          data: { redemptionCount: { increment: 1 } },
        });
      } catch (err: any) {
        // Unique-violation (P2002) = the order was already attributed to
        // this campaign (idempotent retry) — fine to ignore. Anything
        // else is logged and skipped; insights must never break checkout.
        if (err?.code !== "P2002") {
          this.logger.warn(
            `Redemption write skipped (order ${args.order.id}, campaign ${t.campaignId}): ${err?.message}`,
          );
        }
      }
    }
  }

  // Map campaign-stored MenuItem ids onto the SERVED menu's items, so
  // item-based promos survive the operator republishing or a per-location
  // menu assignment (Phase BA) pointing the storefront at a different menu
  // row. Returns oldId → servedId for every id we can re-anchor; ids that
  // already exist in the served menu map to themselves; ids with no
  // equivalent (item not on this menu) are omitted. Stable keys, in order:
  // externalId (survives re-imports/republishes), then normalised name.
  /**
   * Phase BF — overwrite each item/SKU/modifier-option price in place with
   * its override from `variantMap`, when one exists; anything with no
   * override for this variant keeps its own stored price untouched. Called
   * on the menu object right before it's returned to the customer, so the
   * storefront never has to know variant pricing exists.
   */
  private applyVariantPriceOverrides(menu: any, variantMap: VariantPriceMap): void {
    for (const category of menu.categories ?? []) {
      // A configured variant restricts the storefront to ONLY that
      // variant's own brand's items — everything else is removed from the
      // category entirely, not merely left at its own price.
      category.items = (category.items ?? []).filter(
        (link: any) => link.item && variantMap.appliesToItem(link.item),
      );
      for (const link of category.items) {
        const item = link.item;
        if (item.hasMultipleSkus && Array.isArray(item.productSkus)) {
          for (const sku of item.productSkus) {
            const override = variantMap.skuPrice(item, sku);
            if (override !== undefined) sku.price = override;
          }
        } else {
          const override = variantMap.itemPrice(item);
          if (override !== undefined) item.basePrice = override;
        }
        for (const gl of item.modifierGroupLinks ?? []) {
          for (const opt of gl.group?.options ?? []) {
            const override = variantMap.optionPrice(opt);
            if (override !== undefined) opt.priceAdjustment = override;
          }
        }
      }
    }
  }

  private async anchorPromoItemsToServedMenu(
    menu: any,
    referencedIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const ids = Array.from(new Set(referencedIds.filter(Boolean)));
    if (ids.length === 0) return map;

    const norm = (s: unknown) =>
      String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const servedIds = new Set<string>();
    const byExternal = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const cat of menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const it = link.item ?? {};
        const id: string | undefined = it.id ?? link.itemId;
        if (!id) continue;
        servedIds.add(id);
        if (it.externalId) byExternal.set(String(it.externalId), id);
        if (it.name && !byName.has(norm(it.name))) byName.set(norm(it.name), id);
      }
    }

    // Ids already on the served menu need no translation.
    const stale: string[] = [];
    for (const id of ids) {
      if (servedIds.has(id)) map.set(id, id);
      else stale.push(id);
    }
    if (stale.length === 0) return map;

    // Look up the stale ids' stable keys and re-anchor by externalId → name.
    const rows = await this.prisma.menuItem.findMany({
      where: { id: { in: stale } },
      select: { id: true, name: true, externalId: true },
    });
    for (const r of rows) {
      const served =
        (r.externalId && byExternal.get(String(r.externalId))) ||
        (r.name && byName.get(norm(r.name))) ||
        null;
      if (served) map.set(r.id, served);
    }
    return map;
  }

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


/**
 * Don't ship the same logo twice.
 *
 * Operators upload logos that land in Postgres as base64 data URIs, and the
 * storefront carries one on the location AND an identical copy on the brand —
 * 304KB each on a real shop, 31% of a 2MB payload, for an image the page uses
 * once. It reads brand.logoUrl and only falls back to the location's, so when
 * the two are byte-identical the location copy is dead weight on every
 * customer's first load.
 *
 * This treats the symptom. The cause is storing image bytes in a JSON column
 * instead of object storage behind a URL; fixing that removes ~600KB rather
 * than 300KB and is the change actually worth making.
 */
function dedupeLogo(locationView: any, brandView: any) {
  if (!locationView?.logoUrl || !brandView?.logoUrl) return locationView;
  if (locationView.logoUrl !== brandView.logoUrl) return locationView;
  return { ...locationView, logoUrl: null };
}
