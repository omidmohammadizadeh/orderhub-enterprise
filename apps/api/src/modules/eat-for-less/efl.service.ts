// Eat For Less — our own marketplace app, sold through OrderHub.
//
// A shop's Eat For Less menu IS its storefront menu (at Eat For Less prices
// when the brand set some), and an Eat For Less order goes through the
// storefront's checkout: same server pricing, same Stripe account, same
// board and kitchen. What this service adds is the marketplace around it —
// which shops are near you, and the rules a stranger's app needs that a
// shop's own website doesn't (a verified phone, a capped first order, a PIN
// at the door, our commission).

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { usesTap } from "@orderhub/shared";
import { createHash, randomInt, timingSafeEqual } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrderingService, type CheckoutDto } from "../ordering/ordering.service";
import { DeliveryZonesService, milesBetween } from "../delivery-zones/delivery-zones.service";
import { PauseService } from "../pauses/pause.service";
import { isCurrentlyOpen } from "../../common/opening-hours.util";
import { defaultSmsFrom, isSmsConfigured, sendSmsViaProvider } from "../sms/sms-provider";
import { toE164 } from "../sms/phone";
import { ChatService } from "../chat/chat.service";
import { EflCallsService } from "./efl-calls.service";
import { EflAdsService } from "./efl-ads.service";
import { PaymentsService } from "../payments/payments.service";
import { MollieService } from "../payments/mollie/mollie.service";
import {
  EFL_SEARCH_RADIUS_MILES,
  commissionPercentFor,
  deliveryWindow,
  callLineOpen,
  eflCommissionPence,
  travelMinutes,
  generateDeliveryPin,
  isListingLive,
  needsDeliveryPin,
  orderRefusal,
  toRulesConfig,
  type EflRulesConfig,
} from "./efl-rules";

/** What a shop can change about its own listing. Commission and approval
 *  are ours and live on the admin path. */
export interface UpdateListingInput {
  listed?: boolean;
  brandId?: string | null;
  deliveryMode?: "OWN_DRIVERS" | "COURIER" | "OWN_THEN_COURIER";
  acceptsDelivery?: boolean;
  acceptsCollection?: boolean;
  description?: string | null;
  heroImageUrl?: string | null;
  logoUrl?: string | null;
  cuisines?: string[];
  statementEmail?: string | null;
}

export interface AdminUpdateListingInput {
  status?: "PENDING" | "APPROVED" | "SUSPENDED";
  /** Null puts the shop back on the platform default. */
  commissionPercent?: number | null;
  hiddenReason?: string | null;
}

export interface UpdateConfigInput {
  defaultCommissionPercent?: number;
  pinMinOrderTotal?: number;
  pinForNewCustomers?: boolean;
  firstOrderMaxTotal?: number;
  maxOrdersPerHour?: number;
  minHygieneRating?: number;
}

const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
const PHONE_CODE_MAX_ATTEMPTS = 5;
const PHONE_CODES_PER_HOUR = 5;

/** Location fields a listing needs, in one select so every path agrees. */
const LISTING_LOCATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  onlineOrderingSlug: true,
  isActive: true,
  deletedAt: true,
  latitude: true,
  longitude: true,
  openingHours: true,
  timezone: true,
  addressLine1: true,
  city: true,
  postcode: true,
  country: true,
  brandId: true,
  brand: { select: { id: true, name: true, logoUrl: true, tenantId: true } },
} as const;

@Injectable()
export class EflService {
  private readonly logger = new Logger(EflService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordering: OrderingService,
    private readonly deliveryZones: DeliveryZonesService,
    private readonly pauses: PauseService,
    // Approval checks the shop can actually be paid through Stripe. Optional
    // so the unit tests' positional constructors keep working.
    @Optional() private readonly payments?: PaymentsService,
    @Optional() private readonly mollie?: MollieService,
    @Optional() private readonly calls?: EflCallsService,
    @Optional() private readonly chat?: ChatService,
    @Optional() private readonly ads?: EflAdsService,
  ) {}

  // ── Settings ───────────────────────────────────────────────────────────

  async rulesConfig(): Promise<EflRulesConfig> {
    const row = await this.prisma.eflConfig.findUnique({ where: { id: "default" } });
    return toRulesConfig(row as any);
  }

  async getConfig() {
    const row = await this.prisma.eflConfig.findUnique({ where: { id: "default" } });
    return { ...toRulesConfig(row as any), minHygieneRating: row?.minHygieneRating ?? 2 };
  }

  async updateConfig(input: UpdateConfigInput) {
    await this.prisma.eflConfig.upsert({
      where: { id: "default" },
      create: { id: "default", ...input },
      update: input,
    });
    return this.getConfig();
  }

  // ── The app: finding shops ────────────────────────────────────────────

  /**
   * Shops near a customer, open ones first, nearest first.
   *
   * Everything within EFL_SEARCH_RADIUS_MILES is returned, including shops
   * that can't deliver to this address — the customer may still collect.
   * Whether delivery is possible, and what it costs, comes from the shop's
   * own delivery zones, the same answer its storefront would give.
   */
  async discover(point: { lat: number; lng: number; postcode?: string }, viewerKey?: string) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      throw new BadRequestException("A location is needed to find shops near you.");
    }
    const listings = await this.prisma.eflListing.findMany({
      where: { listed: true, status: "APPROVED", hiddenReason: null },
      include: { location: { select: LISTING_LOCATION_SELECT } },
    });
    const prep = await this.prepMinutesFor(listings.map((l) => ({ locationId: l.locationId, brandId: l.brandId ?? l.location?.brandId ?? null })));
    const ratings = await this.ratingsFor(listings.map((l) => l.locationId));

    const results = await Promise.all(
      listings.map(async (listing) => {
        const loc = listing.location;
        if (!loc || !loc.isActive || loc.deletedAt) return null;

        // Coordinates are lazy — nothing writes them until something needs
        // them — so a newly listed shop is placed on its first search.
        const where =
          loc.latitude != null && loc.longitude != null
            ? { lat: loc.latitude, lng: loc.longitude }
            : await this.deliveryZones.locateShop(loc.id).catch(() => null);
        if (!where) return null;
        const distanceMiles = milesBetween(where, point);
        if (distanceMiles > EFL_SEARCH_RADIUS_MILES) return null;

        const brandId = listing.brandId ?? loc.brandId;
        const [paused, delivery] = await Promise.all([
          this.pauses
            .isPaused({ locationId: loc.id, brandId, channel: "EAT_FOR_LESS" as any })
            .then((p) => p.paused)
            .catch(() => false),
          listing.acceptsDelivery
            ? this.deliveryZones
                .publicQuote(loc.id, { lat: point.lat, lng: point.lng, postcode: point.postcode, brandId })
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const open = !paused && isCurrentlyOpen(loc.openingHours as any, loc.timezone);
        const shopPrep = prep.get(loc.id) ?? { delivery: 45, collection: 20 };

        return {
          id: listing.id,
          name: loc.brand?.name ?? loc.name,
          area: loc.city ?? null,
          logoUrl: listing.logoUrl ?? loc.brand?.logoUrl ?? null,
          heroImageUrl: listing.heroImageUrl,
          description: listing.description,
          cuisines: listing.cuisines,
          distanceMiles: Math.round(distanceMiles * 10) / 10,
          isOpen: open,
          rating: ratings.get(loc.id) ?? null,
          delivery: {
            available: !!delivery?.matched,
            fee: delivery?.matched ? delivery.fee : null,
            minOrder: delivery?.matched ? delivery.minOrderValue ?? null : null,
            etaMinutes: delivery?.matched ? deliveryWindow(shopPrep.delivery, distanceMiles) : null,
          },
          collection: {
            available: listing.acceptsCollection,
            readyInMinutes: listing.acceptsCollection ? shopPrep.collection : null,
          },
        };
      }),
    );

    const shops = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || a.distanceMiles - b.distanceMiles);

    // Sponsored places: an auction among shops this viewer could order from.
    // Winners move to the top, marked; the price stays inside the token.
    const placed =
      this.ads && viewerKey
        ? await this.ads
            .sponsor(
              shops.map((s) => ({ id: s.id, isOpen: s.isOpen, orderable: s.delivery.available || s.collection.available })),
              viewerKey,
            )
            .catch((e) => {
              this.logger.warn(`Sponsored places skipped: ${(e as Error).message}`);
              return new Map<string, { token: string }>();
            })
        : new Map<string, { token: string }>();
    const withAds = shops.map((s) => ({ ...s, sponsored: placed.has(s.id) ? { token: placed.get(s.id)!.token } : null }));
    const order = [...placed.keys()];
    return [
      ...order.map((id) => withAds.find((s) => s.id === id)!).filter(Boolean),
      ...withAds.filter((s) => !placed.has(s.id)),
    ];
  }

  /** A shop's menu as the app shows it: the storefront menu at Eat For Less
   *  prices, plus the listing's own presentation. */
  async menu(listingId: string) {
    const { listing, slug, brandId } = await this.liveListing(listingId);
    const store = await this.ordering.getStorefrontBySlug(slug, brandId, "ONLINE", "EAT_FOR_LESS");
    return {
      listing: {
        id: listing.id,
        heroImageUrl: listing.heroImageUrl,
        logoUrl: listing.logoUrl,
        description: listing.description,
        cuisines: listing.cuisines,
        acceptsDelivery: listing.acceptsDelivery,
        acceptsCollection: listing.acceptsCollection,
      },
      store,
    };
  }

  // ── The app: ordering ─────────────────────────────────────────────────

  /**
   * Place an order. Card only — Apple Pay and Google Pay ride the card
   * rail — so the response carries the PaymentIntent secret and the shop's
   * Stripe account for the app's payment sheet.
   */
  async checkout(customer: { id: string }, listingId: string, body: CheckoutDto, viewerKeys: string[] = []) {
    const { listing, location, slug, brandId } = await this.liveListing(listingId);

    if (body.fulfillmentType === "DELIVERY" && !listing.acceptsDelivery) {
      throw new BadRequestException("This shop isn't delivering through Eat For Less right now.");
    }
    if (body.fulfillmentType === "PICKUP" && !listing.acceptsCollection) {
      throw new BadRequestException("This shop isn't taking collection orders through Eat For Less.");
    }
    if (body.fulfillmentType !== "DELIVERY" && body.fulfillmentType !== "PICKUP") {
      throw new BadRequestException("Choose delivery or collection.");
    }

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: customer.id },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, phoneVerifiedAt: true },
    });
    if (!account) throw new ForbiddenException("Please sign in again.");

    const config = await this.rulesConfig();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [ordersInLastHour, earlierPaid] = await Promise.all([
      this.prisma.order.count({
        where: { customerAccountId: account.id, orderSource: "EAT_FOR_LESS", createdAt: { gte: hourAgo } },
      }),
      this.prisma.order.count({
        where: {
          customerAccountId: account.id,
          orderSource: "EAT_FOR_LESS",
          paymentStatus: { in: ["PAID", "AUTHORIZED"] as any },
        },
      }),
    ]);
    const isNewCustomer = earlierPaid === 0;
    const phoneVerified = !!account.phoneVerifiedAt && !!account.phone;

    // Refuse what can be refused before the basket is priced, so a customer
    // with an unverified phone isn't made to wait for a menu lookup first.
    const early = orderRefusal({
      phoneVerified,
      ordersInLastHour,
      isNewCustomer: false,
      total: 0,
      config,
    });
    if (early) throw new BadRequestException(early);

    const commissionPercent = commissionPercentFor(listing, config);

    // What the app may decide and what it may not. The customer is the
    // signed-in account with the phone they verified; payment is card; and
    // nothing from here subscribes them to the shop's own marketing — the
    // customer belongs to Eat For Less, which asks for its own consent.
    const dto: CheckoutDto = {
      ...body,
      customerInfo: {
        name: `${account.firstName} ${account.lastName}`.trim() || "Eat For Less customer",
        phone: account.phone!,
        email: account.email,
      },
      customerAccountId: account.id,
      paymentMethod: "CARD",
      embedded: true,
      marketingConsent: false,
      emailMarketingConsent: false,
      emailRecipientId: undefined,
    };

    const result: any = await this.ordering.checkout(slug, dto, brandId, null, {
      orderSource: "EAT_FOR_LESS",
      pauseChannel: "EAT_FOR_LESS",
      priceChannel: "EAT_FOR_LESS",
      beforeCreate: async (totals) => {
        const refusal = orderRefusal({ phoneVerified, ordersInLastHour, isNewCustomer, total: totals.total, config });
        if (refusal) throw new BadRequestException(refusal);
      },
      afterCreate: async (order) => {
        const pin = needsDeliveryPin({
          fulfillmentType: body.fulfillmentType,
          total: Number(order.total ?? 0),
          isNewCustomer,
          config,
        })
          ? generateDeliveryPin()
          : null;
        // Sponsored-listing spend still owed, taken back on this order's
        // fee (capped per order). Ads must never stop an order going in.
        const adRecovered = this.ads ? await this.adRecoveryFor(order.id, listing.id, location.id) : 0;
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            eflCommissionPercent: commissionPercent,
            deliveryPin: pin,
            ...(adRecovered > 0 ? { eflAdRecovered: adRecovered } : {}),
          },
        });
        if (this.ads && viewerKeys.length) {
          await this.ads
            .attributeOrder({ listingId: listing.id, viewerKeys, orderId: order.id })
            .catch(() => undefined);
        }
      },
    });

    if (!result?.clientSecret && !result?.checkoutUrl && Number(result?.total ?? 0) > 0) {
      this.logger.error(`EFL order ${result?.id} at ${location.id} was created with no way to pay`);
    }

    return {
      orderId: result.id,
      displayId: result.displayId ?? null,
      total: Number(result.total),
      clientSecret: result.clientSecret ?? null,
      stripeAccountId: result.stripeAccountId ?? null,
      amountPence: result.amountPence ?? null,
      // A shop on a hosted-only provider: the app opens this instead of
      // the payment sheet.
      checkoutUrl: result.checkoutUrl ?? null,
    };
  }

  private async adRecoveryFor(orderId: string, listingId: string, locationId: string): Promise<number> {
    try {
      const priced = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { subtotal: true, discount: true },
      });
      const food = Math.max(0, Number(priced?.subtotal ?? 0) - Number(priced?.discount ?? 0));
      return await this.ads!.recoveryForOrder(listingId, locationId, food);
    } catch {
      return 0;
    }
  }

  /** One of the customer's own orders, with its delivery PIN. The PIN is the
   *  customer's to give, so only the customer's own request ever returns it. */
  async myOrder(customer: { id: string }, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerAccountId: customer.id, orderSource: "EAT_FOR_LESS" },
      select: {
        id: true,
        status: true,
        deliveredAt: true,
        updatedAt: true,
        deliveryPin: true,
        deliveryPinVerifiedAt: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const status: any = await this.ordering.getOrderStatus(order.id);
    return {
      ...status,
      // Never the driver's own number: the customer calls through the
      // private line, and the driver never sees theirs either.
      driver: status.driver ? withoutPhone(status.driver) : null,
      driverEtaMinutes: driverEta(status.driver, status.destination),
      deliveryPin: order.deliveryPinVerifiedAt ? null : order.deliveryPin,
      handedOver: !!order.deliveryPinVerifiedAt,
      // Our number and the customer's code, while the line is open. Null
      // when private calls aren't set up yet or the line has closed.
      privateLine: (await this.calls?.customerLine(order)) ?? null,
    };
  }

  /** Messages between the customer and their driver on one order. */
  async myOrderMessages(customer: { id: string }, orderId: string) {
    await this.ownOrder(customer, orderId);
    if (!this.chat) return [];
    const messages = await this.chat.customerThread(orderId);
    await this.chat.readCustomerThread(orderId, "CUSTOMER");
    return messages;
  }

  async sendMyOrderMessage(customer: { id: string }, orderId: string, body: string) {
    const order = await this.ownOrder(customer, orderId);
    const text = String(body ?? "").trim().slice(0, 500);
    if (!text) throw new BadRequestException("Write a message first.");
    if (!callLineOpen(order, new Date())) {
      throw new BadRequestException("Messages close two hours after delivery.");
    }
    if (!this.chat) throw new BadRequestException("Messages aren't available right now.");
    // First name only: it's what a driver needs at a door.
    return this.chat.postCustomerDriver(orderId, "CUSTOMER", text, order.customerName?.split(" ")[0] ?? null);
  }

  private async ownOrder(customer: { id: string }, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerAccountId: customer.id, orderSource: "EAT_FOR_LESS" },
      select: { id: true, status: true, deliveredAt: true, updatedAt: true, customerName: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async myOrders(customer: { id: string }) {
    return this.prisma.order.findMany({
      where: { customerAccountId: customer.id, orderSource: "EAT_FOR_LESS" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        displayId: true,
        status: true,
        total: true,
        createdAt: true,
        fulfillmentType: true,
        location: { select: { name: true, eflListing: { select: { id: true } } } },
        brand: { select: { name: true } },
      },
    });
  }

  // ── The app: proving a phone number ───────────────────────────────────

  async startPhoneVerification(customer: { id: string }, rawPhone: string) {
    const phone = toE164(rawPhone);
    if (!phone) {
      throw new BadRequestException("That doesn't look like a mobile number. Enter it as 07700 900123.");
    }
    if (!isSmsConfigured()) {
      throw new BadRequestException("Text messages aren't set up yet. Please try again later.");
    }
    const recent = await this.prisma.eflPhoneVerification.count({
      where: { customerAccountId: customer.id, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= PHONE_CODES_PER_HOUR) {
      throw new BadRequestException("Too many codes requested. Please wait an hour and try again.");
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.prisma.eflPhoneVerification.create({
      data: {
        customerAccountId: customer.id,
        phone,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + PHONE_CODE_TTL_MS),
      },
    });
    // Sent from our own sender, not through SmsService: that path bills a
    // shop's prepaid wallet, and this text belongs to no shop.
    await sendSmsViaProvider({
      to: phone,
      from: defaultSmsFrom(),
      body: `Your Eat For Less code is ${code}. It expires in 10 minutes. Never share it with anyone.`,
    });
    return { sent: true, phone: maskPhone(phone) };
  }

  async verifyPhone(customer: { id: string }, code: string) {
    const row = await this.prisma.eflPhoneVerification.findFirst({
      where: { customerAccountId: customer.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new BadRequestException("That code has expired. Please ask for a new one.");
    if (row.attempts >= PHONE_CODE_MAX_ATTEMPTS) {
      throw new BadRequestException("Too many wrong codes. Please ask for a new one.");
    }
    if (!sameHash(row.codeHash, hashCode(String(code ?? "").trim()))) {
      await this.prisma.eflPhoneVerification.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("That code isn't right. Please check it and try again.");
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.eflPhoneVerification.update({ where: { id: row.id }, data: { consumedAt: now } }),
      this.prisma.customerAccount.update({
        where: { id: customer.id },
        data: { phone: row.phone, phoneVerifiedAt: now },
      }),
    ]);
    return { verified: true };
  }

  async setMarketing(customer: { id: string }, optIn: boolean) {
    await this.prisma.customerAccount.update({
      where: { id: customer.id },
      data: { eflMarketingOptIn: optIn },
    });
    return { eflMarketingOptIn: optIn };
  }

  // ── OrderHub: a shop's own listing ────────────────────────────────────

  async getListing(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const [listing, config] = await Promise.all([
      this.prisma.eflListing.findUnique({ where: { locationId } }),
      this.rulesConfig(),
    ]);
    return this.shapeListingForShop(listing, locationId, config);
  }

  async updateListing(tenantId: string, locationId: string, input: UpdateListingInput) {
    await this.assertLocation(tenantId, locationId);
    if (input.statementEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.statementEmail.trim())) {
      throw new BadRequestException("That email address doesn't look right.");
    }
    if (input.brandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: input.brandId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!brand) throw new BadRequestException("That brand isn't one of yours.");
    }
    const data = {
      ...(input.listed !== undefined ? { listed: input.listed } : {}),
      ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
      ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
      ...(input.acceptsDelivery !== undefined ? { acceptsDelivery: input.acceptsDelivery } : {}),
      ...(input.acceptsCollection !== undefined ? { acceptsCollection: input.acceptsCollection } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.heroImageUrl !== undefined ? { heroImageUrl: input.heroImageUrl } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.cuisines !== undefined ? { cuisines: input.cuisines.slice(0, 8) } : {}),
      ...(input.statementEmail !== undefined
        ? { statementEmail: input.statementEmail?.trim() ? input.statementEmail.trim().toLowerCase() : null }
        : {}),
    };
    const listing = await this.prisma.eflListing.upsert({
      where: { locationId },
      create: { locationId, ...data },
      update: data,
    });
    // Place the shop on the map now rather than on a customer's first search.
    if (listing.listed) void this.deliveryZones.locateShop(locationId).catch(() => null);
    return this.shapeListingForShop(listing, locationId, await this.rulesConfig());
  }

  // ── Console: every listing, and the platform's decisions ──────────────

  async adminListings() {
    const [rows, config] = await Promise.all([
      this.prisma.eflListing.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          location: { select: { id: true, name: true, city: true, latitude: true, brand: { select: { name: true } } } },
        },
      }),
      this.rulesConfig(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      locationId: r.locationId,
      shopName: r.location?.brand?.name ?? r.location?.name ?? null,
      town: r.location?.city ?? null,
      listed: r.listed,
      status: r.status,
      hiddenReason: r.hiddenReason,
      live: isListingLive(r),
      commissionPercent: commissionPercentFor(r, config),
      commissionIsDefault: r.commissionPercent == null,
      deliveryMode: r.deliveryMode,
      placedOnMap: r.location?.latitude != null,
      online: !!r.lastDeviceSeenAt && Date.now() - r.lastDeviceSeenAt.getTime() < 2 * 60 * 1000,
      lastDeviceSeenAt: r.lastDeviceSeenAt,
      offlineSince: r.offlineSince,
      approvedAt: r.approvedAt,
      createdAt: r.createdAt,
    }));
  }

  async adminUpdateListing(id: string, input: AdminUpdateListingInput) {
    const existing = await this.prisma.eflListing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Listing not found");
    if (input.commissionPercent != null && (input.commissionPercent < 0 || input.commissionPercent > 40)) {
      throw new BadRequestException("Commission must be between 0% and 40%.");
    }
    if (input.status === "APPROVED") await this.assertPayableThroughStripe(existing);
    await this.prisma.eflListing.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.status === "APPROVED" && !existing.approvedAt ? { approvedAt: new Date() } : {}),
        ...(input.commissionPercent !== undefined ? { commissionPercent: input.commissionPercent } : {}),
        ...(input.hiddenReason !== undefined ? { hiddenReason: input.hiddenReason } : {}),
      },
    });
    return (await this.adminListings()).find((l) => l.id === id);
  }

  /** The Console's front page: where the listings stand, and today's trade.
   *  "Today" is the UK day — the pilot is in Newcastle. Only paid orders
   *  count: an unpaid card order is a basket, not a sale. */
  async adminSummary() {
    const startOfDay = startOfLondonDay(new Date());
    const [listings, orders] = await Promise.all([
      this.prisma.eflListing.findMany({
        select: { listed: true, status: true, hiddenReason: true, lastDeviceSeenAt: true },
      }),
      this.prisma.order.findMany({
        where: {
          orderSource: "EAT_FOR_LESS",
          createdAt: { gte: startOfDay },
          paymentStatus: { in: ["PAID", "AUTHORIZED"] as any },
        },
        select: { total: true, subtotal: true, discount: true, eflCommissionPercent: true },
      }),
    ]);
    const sales = orders.reduce((sum, o) => sum + Number(o.total ?? 0), 0);
    const commissionPence = orders.reduce((sum, o) => sum + eflCommissionPence(o), 0);
    return {
      listings: {
        total: listings.length,
        live: listings.filter(isListingLive).length,
        waitingApproval: listings.filter((l) => l.listed && l.status === "PENDING").length,
        suspended: listings.filter((l) => l.status === "SUSPENDED").length,
        hidden: listings.filter((l) => !!l.hiddenReason).length,
        offline: listings.filter((l) => l.hiddenReason === "OFFLINE").length,
      },
      today: {
        orders: orders.length,
        sales: Math.round(sales * 100) / 100,
        commission: commissionPence / 100,
      },
    };
  }

  /** Place every listed shop that has no coordinates yet. Each one is a
   *  geocode call, so this runs on demand rather than on every search. */
  async adminPlaceShopsOnMap() {
    const rows = await this.prisma.eflListing.findMany({
      where: { location: { latitude: null } },
      select: { locationId: true },
    });
    let placed = 0;
    for (const r of rows) {
      if (await this.deliveryZones.locateShop(r.locationId).catch(() => null)) placed++;
    }
    return { checked: rows.length, placed };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Our commission is taken as Stripe's application fee on the shop's own
   * Stripe account. A shop paid through Tap or Mollie would be charged with
   * no commission at all, and one with no Stripe account can't be paid — so
   * neither is approved until that changes.
   */
  private async assertPayableThroughStripe(listing: { locationId: string; brandId: string | null }) {
    const location = await this.prisma.location.findUnique({
      where: { id: listing.locationId },
      select: { id: true, country: true, brandId: true, brand: { select: { tenantId: true } } },
    });
    if (!location) throw new NotFoundException("Location not found");
    const brandId = listing.brandId ?? location.brandId;
    if (usesTap(location.country)) {
      throw new BadRequestException("This shop takes cards through Tap. Eat For Less needs Stripe — it can't be approved yet.");
    }
    if (await this.mollie?.activeConnectionForBrand(brandId)) {
      throw new BadRequestException("This brand takes cards through Mollie. Eat For Less needs Stripe — it can't be approved yet.");
    }
    if (this.payments && location.brand?.tenantId) {
      const connect = await this.payments.resolveConnectAccount(location.brand.tenantId, location.id, brandId);
      if (!connect) {
        throw new BadRequestException("This shop hasn't connected Stripe yet, so it couldn't be paid. Ask it to connect Stripe first.");
      }
    }
  }

  /** A listing a customer may order from, or a 404 that doesn't say why. */
  private async liveListing(listingId: string) {
    const listing = await this.prisma.eflListing.findUnique({
      where: { id: listingId },
      include: { location: { select: LISTING_LOCATION_SELECT } },
    });
    const location = listing?.location;
    if (!listing || !location || !isListingLive(listing) || !location.isActive || location.deletedAt) {
      throw new NotFoundException("This shop isn't on Eat For Less right now.");
    }
    return {
      listing,
      location,
      slug: location.onlineOrderingSlug ?? location.slug ?? location.id,
      brandId: listing.brandId ?? undefined,
    };
  }

  /** Each shop's prep times, from its ordering settings: the location's own,
   *  else its brand's, else the storefront's defaults. */
  private async prepMinutesFor(shops: Array<{ locationId: string; brandId: string | null }>) {
    const rows = await this.prisma.directOrderingConfig.findMany({
      where: {
        OR: [
          { locationId: { in: shops.map((s) => s.locationId) } },
          { brandId: { in: shops.map((s) => s.brandId).filter((b): b is string => !!b) } },
        ],
      },
      select: { locationId: true, brandId: true, deliveryPrepMinutes: true, collectionPrepMinutes: true } as any,
    });
    const out = new Map<string, { delivery: number; collection: number }>();
    for (const shop of shops) {
      const row: any =
        rows.find((r: any) => r.locationId === shop.locationId) ?? rows.find((r: any) => shop.brandId && r.brandId === shop.brandId);
      out.set(shop.locationId, {
        delivery: Number(row?.deliveryPrepMinutes ?? 45),
        collection: Number(row?.collectionPrepMinutes ?? 20),
      });
    }
    return out;
  }

  /** Published review average and count per shop, in one query. */
  private async ratingsFor(locationIds: string[]) {
    const out = new Map<string, { value: number; count: number }>();
    if (locationIds.length === 0) return out;
    const grouped = await this.prisma.review.groupBy({
      by: ["locationId"],
      where: { locationId: { in: locationIds }, status: "PUBLISHED" },
      _avg: { rating: true },
      _count: { rating: true },
    });
    for (const g of grouped) {
      if (!g._count.rating) continue;
      out.set(g.locationId, { value: Math.round(Number(g._avg.rating ?? 0) * 10) / 10, count: g._count.rating });
    }
    return out;
  }

  async assertLocation(tenantId: string, locationId: string) {
    // A location has no tenantId of its own; it hangs off its brand.
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  private shapeListingForShop(listing: any, locationId: string, config: EflRulesConfig) {
    return {
      locationId,
      exists: !!listing,
      listed: listing?.listed ?? false,
      status: listing?.status ?? "PENDING",
      hiddenReason: listing?.hiddenReason ?? null,
      live: listing ? isListingLive(listing) : false,
      // Shown to the shop, set by us.
      commissionPercent: commissionPercentFor(listing, config),
      brandId: listing?.brandId ?? null,
      deliveryMode: listing?.deliveryMode ?? "OWN_DRIVERS",
      acceptsDelivery: listing?.acceptsDelivery ?? true,
      acceptsCollection: listing?.acceptsCollection ?? true,
      description: listing?.description ?? null,
      heroImageUrl: listing?.heroImageUrl ?? null,
      logoUrl: listing?.logoUrl ?? null,
      cuisines: listing?.cuisines ?? [],
      statementEmail: listing?.statementEmail ?? null,
    };
  }
}

function withoutPhone<T extends Record<string, unknown>>(driver: T) {
  const { phone: _phone, ...rest } = driver as any;
  return rest as Omit<T, "phone">;
}

/** Minutes until the driver reaches the customer, from the driver's last GPS
 *  ping. Null until there's a driver on the road with a position. */
function driverEta(
  driver: { lat?: number | null; lng?: number | null } | null | undefined,
  destination: { lat: number; lng: number } | null | undefined,
): number | null {
  if (driver?.lat == null || driver?.lng == null || !destination) return null;
  return travelMinutes(milesBetween({ lat: driver.lat, lng: driver.lng }, destination));
}

/** Midnight in London on the day `now` falls in, as a UTC instant. */
export function startOfLondonDay(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const londonAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = londonAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")) - offsetMs);
}

/** Codes are kept as a keyed hash: a leaked table row can't be replayed. */
function hashCode(code: string): string {
  const pepper = process.env.JWT_SECRET ?? "efl-dev-pepper";
  return createHash("sha256").update(`${pepper}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** +447700900482 → 07••• •••482: enough to recognise, not enough to copy. */
export function maskPhone(e164: string): string {
  const tail = e164.slice(-3);
  return e164.startsWith("+44") ? `07••• •••${tail}` : `•••••••${tail}`;
}
