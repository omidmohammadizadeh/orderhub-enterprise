import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderStatus,
  FulfillmentType,
  DriverPresenceStatus,
  DriverAssignmentStatus,
} from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { coercePostcodeFees, matchPostcodeFee } from "./driver-earnings.service";
import { driverIdsForLocations } from "../../common/access/accessible-locations";
import { GeocodingService } from "./geocoding.service";
import { ExpoPushService } from "../driver-app/expo-push.service";

// Order is "assigned" (a driver has it → grey + locked on the map) once it's
// past dispatch into a driver-owned status.
const ASSIGNED_STATUSES: OrderStatus[] = [
  OrderStatus.ASSIGNED_DRIVER,
  OrderStatus.ACCEPTED_BY_DRIVER,
  OrderStatus.RIDER_ARRIVED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DISPATCHED,
];

// Order statuses that still need a driver / are mid-delivery — i.e. everything
// that should show on the dispatch map. Terminal + pre-acceptance states are
// excluded (COMPLETED/CANCELLED/REJECTED/FAILED fade off; PENDING isn't live).
const ACTIVE_DISPATCH_STATUSES: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PENDING_DISPATCH,
  OrderStatus.ASSIGNED_DRIVER,
  OrderStatus.ACCEPTED_BY_DRIVER,
  OrderStatus.RIDER_ARRIVED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DISPATCHED,
];

const DELIVERY_FULFILLMENTS: FulfillmentType[] = [
  FulfillmentType.DELIVERY,
  FulfillmentType.MERCHANT_DELIVERY,
  FulfillmentType.PLATFORM_COURIER,
];

const DEFAULT_PREP_MINUTES = 20;

// A rider who stopped reporting this long ago is not "there". A pin frozen at
// their last known spot is worse than no pin, because the operator believes it.
const STALE_COURIER_MIN = 15;

/** Whoever is carrying one order: our own driver, or a third-party rider. */
export interface OrderMapRider {
  kind: "DRIVER" | "COURIER";
  name: string | null;
  lat: number;
  lng: number;
  seenAt: string | null;
  /** How old the fix is. The UI says so rather than implying it is live. */
  ageMinutes: number | null;
}

/** The dispatch map narrowed to a single order — see getOrderMap. */
export interface OrderMapView {
  order: {
    id: string;
    ref: string | null;
    status: OrderStatus;
    customerName: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  shop: {
    id: string;
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  rider: OrderMapRider | null;
}

export interface DispatchLocationPin {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface DispatchOrderPin {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: OrderStatus;
  platform: string;
  deliveryType: string | null;
  locationId: string;
  customerName: string | null;
  total: string;
  paymentMethod: string | null;
  lat: number | null;
  lng: number | null;
  // The moment this order is "due" — drives the countdown + colour on the map.
  deadlineAt: string | null;
  createdAt: string;
  done: boolean; // delivered/completed in the last 10 min — render grey, then it drops off
  assigned: boolean; // a driver currently has this order — grey + locked on the map
}

export interface DispatchDriverDot {
  driverId: string;
  name: string;
  status: DriverPresenceStatus;
  locationId: string | null;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  activeAssignmentId: string | null;
  lastPingAt: string | null;
}

/**
 * A marketplace or third-party courier we do not employ, plotted from the
 * position the provider sends.
 *
 * Kept apart from DispatchDriverDot deliberately: these riders cannot be
 * assigned work, re-routed or messaged, and folding them into the fleet list
 * would offer the operator controls that do nothing.
 *
 * Only some providers send a position at all — see Order.courierLat.
 */
export interface DispatchCourierPin {
  orderId: string;
  ref: string | null;
  platform: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  lat: number;
  lng: number;
  /** When the provider took the fix. The map fades and then drops a stale one. */
  seenAt: string;
  /** Minutes old at the moment the feed was built. */
  ageMinutes: number;
}

export interface DispatchFeed {
  scope: string[];
  locations: DispatchLocationPin[];
  orders: DispatchOrderPin[];
  drivers: DispatchDriverDot[];
  couriers: DispatchCourierPin[];
}

// ── Operator dashboard shapes ─────────────────────────────────────────────────
export interface OperatorStats {
  online: number;
  busy: number;
  outForDelivery: number;
  deliveredToday: number;
  attention: number;
  failedToday: number;
}
export interface OperatorOrderRow {
  id: string;
  ref: string;
  customerName: string | null;
  status: OrderStatus;
  deadlineAt: string | null;
  minutesLate: number | null;
  driverName: string | null;
  address: string | null;
}
export interface OperatorDriverJob {
  orderId: string;
  ref: string;
  customerName: string | null;
  status: DriverAssignmentStatus;
  sequence: number | null;
  address: string | null;
}
export interface OperatorDriverRow {
  id: string;
  name: string;
  status: DriverPresenceStatus;
  lastPingAt: string | null;
  activeJobs: OperatorDriverJob[];
  delivered: number;
  cashTotal: string;
  cardTotal: string;
  total: string;
  // Phase BG — home location + pay config (for the Manage/earnings panel) and
  // the driver's computed earning so far today.
  homeLocationId: string | null;
  startupFee: string;
  postcodeFees: { postcode: string; fee: number }[];
  earningToday: string;
}
export interface OperatorFailedRow {
  id: string;
  ref: string;
  customerName: string | null;
  status: OrderStatus;
  reason: string | null;
  at: string;
}
export interface OperatorDashboard {
  scope: string[];
  stats: OperatorStats;
  attention: OperatorOrderRow[];
  outForDelivery: OperatorOrderRow[];
  drivers: OperatorDriverRow[];
  recentFailed: OperatorFailedRow[];
}

const OUT_FOR_DELIVERY_STATUSES: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.RIDER_ARRIVED,
  OrderStatus.DISPATCHED,
];

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  // In-memory cache of geocoded LOCATION pins (locations have no lat/lng column
  // yet — cheap to cache here since there are only a handful per tenant).
  private readonly locationGeoCache = new Map<string, { lat: number; lng: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoder: GeocodingService,
    private readonly expoPush: ExpoPushService,
  ) {}

  /** Locations this user is allowed to see on the dispatch map. Only the
   *  tenant-wide admins (PLATFORM_ADMIN / TENANT_OWNER) see every location;
   *  everyone else — including the scoped OWNER (location owner) role — is
   *  constrained to their UserLocation ∪ the locations their assigned
   *  brands (UserBrand) operate at. Matches the app-wide scoping. */
  /** Online own-fleet drivers for the dispatch modal — clocked in (ONLINE or
   *  ON_JOB) at the given location (or any accessible one). Includes their live
   *  active-job count so the operator can pick the least-busy driver. */
  async listOnlineDrivers(
    user: AuthenticatedUser,
    locationId?: string,
  ): Promise<
    Array<{
      driverId: string;
      name: string;
      phone: string;
      status: DriverPresenceStatus;
      activeJobs: number;
    }>
  > {
    const accessible = await this.resolveAccessibleLocationIds(user);
    // A driver's shop is their Team Roles assignment — see
    // driverIdsForLocations. Reading Driver.locationId here is what kept a
    // newly-assigned driver off their own shop's map.
    const inScope =
      locationId && locationId !== "all"
        ? accessible.includes(locationId)
          ? [locationId]
          : []
        : accessible;
    const driverIds = await driverIdsForLocations(
      this.prisma,
      user.tenantId,
      inScope,
    );
    const locFilter = { id: { in: driverIds } };
    const drivers = await this.prisma.driver.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        ...locFilter,
        presence: {
          status: {
            in: [DriverPresenceStatus.ONLINE, DriverPresenceStatus.ON_JOB],
          },
        },
      },
      include: {
        presence: { select: { status: true } },
        assignments: {
          where: {
            status: {
              in: [
                DriverAssignmentStatus.ASSIGNED,
                DriverAssignmentStatus.ACCEPTED,
                DriverAssignmentStatus.PICKED_UP,
              ],
            },
          },
          select: { id: true },
        },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    return drivers.map((d) => ({
      driverId: d.id,
      name: `${d.firstName} ${d.lastName}`.trim(),
      phone: d.phone,
      status: d.presence?.status ?? DriverPresenceStatus.OFFLINE,
      activeJobs: d.assignments.length,
    }));
  }

  private async resolveAccessibleLocationIds(user: AuthenticatedUser): Promise<string[]> {
    if (["PLATFORM_ADMIN", "TENANT_OWNER"].includes(user.role)) {
      // Location is tenant-scoped through its brand (no direct tenantId column).
      const locs = await this.prisma.location.findMany({
        where: { brand: { tenantId: user.tenantId } },
        select: { id: true },
      });
      return locs.map((l) => l.id);
    }
    const [locRows, brandRows] = await Promise.all([
      this.prisma.userLocation.findMany({
        where: { userId: user.userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId: user.userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locRows.map((a) => a.locationId));
    const brandIds: string[] = brandRows.map((b: any) => b.brandId);
    // Explicit location assignments are authoritative — a user scoped to
    // specific locations must NOT be broadened to every location their brands
    // operate at. Only expand brands→locations for brand-only accounts (no
    // explicit location scope). Mirrors LocationsService.accessibleLocationIds.
    if (ids.size === 0 && brandIds.length) {
      const brands = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId: user.tenantId },
        select: {
          primaryLocationId: true,
          locations: { select: { id: true } },
        },
      });
      for (const b of brands) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  /** Build a free-form address string from an order's structured + JSON fields.
   *
   *  The country comes from the SHOP, not a constant. This used to append a
   *  literal ", UK" to every address, so a Dubai delivery was handed to the
   *  geocoder as a British address and resolved to nothing — no pin on the
   *  dispatch map, no explanation. Where the address carries an `area` (the
   *  Gulf community) it goes in too: it is often the only locatable part. */
  private orderAddressString(
    order: {
      addressLine1: string | null;
      city: string | null;
      postcode: string | null;
      deliveryAddress: unknown;
    },
    country = "GB",
  ): string | null {
    const cc = String(country || "GB").trim().toUpperCase();
    const a = order.deliveryAddress as Record<string, unknown> | null;
    const area =
      a && typeof a === "object"
        ? ((a.area ?? a.neighbourhood ?? a.district) as string | undefined)
        : undefined;
    const parts = [order.addressLine1, area, order.city, order.postcode].filter(
      Boolean,
    ) as string[];
    if (parts.length) return `${parts.join(", ")}, ${cc}`;
    // Fallback to the deliveryAddress JSON blob (webhook-ingested shapes).
    if (a && typeof a === "object") {
      const jsonParts = [
        a.line1 ?? a.addressLine1 ?? a.address1 ?? a.street,
        area,
        a.city ?? a.town,
        a.postcode ?? a.postal_code ?? a.zip,
      ].filter(Boolean) as string[];
      if (jsonParts.length) return `${jsonParts.join(", ")}, ${cc}`;
    }
    return null;
  }

  private deadlineFor(order: {
    scheduledFor: Date | null;
    estimatedReadyAt: Date | null;
    preparationMinutes: number | null;
    createdAt: Date;
  }): Date | null {
    if (order.scheduledFor) return order.scheduledFor;
    if (order.estimatedReadyAt) return order.estimatedReadyAt;
    const mins = order.preparationMinutes ?? DEFAULT_PREP_MINUTES;
    return new Date(order.createdAt.getTime() + mins * 60_000);
  }

  /** Many platform payloads carry the customer lat/lng directly in
   *  deliveryAddress — use those before paying to geocode. The coordinates may
   *  sit at the top level OR nested inside a container the marketplace adapters
   *  use (e.g. Deliveroo/Uber self-delivery orders store them under
   *  `deliveryAddress.coordinates.{lat,lng}`), so check both. */
  private coordsFromAddress(deliveryAddress: unknown): { lat: number; lng: number } | null {
    const a = deliveryAddress as Record<string, any> | null;
    if (!a || typeof a !== "object") return null;
    const containers = [
      a,
      a.coordinates,
      a.coordinate,
      a.coords,
      a.location,
      a.geo,
      a.point,
      a.position,
    ].filter((c) => c && typeof c === "object") as Record<string, any>[];
    for (const c of containers) {
      const lat = Number(c.lat ?? c.latitude ?? c.Latitude);
      const lng = Number(c.lng ?? c.lon ?? c.long ?? c.longitude ?? c.Longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return { lat, lng };
      }
    }
    return null;
  }

  /** Resolve + persist coords for any active delivery order missing them:
   *  embedded payload coords first, then geocode the address. */
  private async geocodeMissing(
    orders: Array<{
      id: string;
      deliveryLat: number | null;
      addressLine1: string | null;
      city: string | null;
      postcode: string | null;
      deliveryAddress: unknown;
    }>,
    countryByLocation: Map<string, string> = new Map(),
  ): Promise<Map<string, { lat: number; lng: number }>> {
    const resolved = new Map<string, { lat: number; lng: number }>();
    const missing = orders.filter((o) => o.deliveryLat == null);
    await Promise.all(
      missing.map(async (o) => {
        const country =
          countryByLocation.get((o as { locationId?: string }).locationId ?? "") ??
          "GB";
        const point =
          this.coordsFromAddress(o.deliveryAddress) ??
          (await (async () => {
            const addr = this.orderAddressString(o, country);
            if (!addr) {
              this.logger.log(`dispatch: order ${o.id} has no geocodable address/coords — no pin`);
              return null;
            }
            const p = await this.geocoder.geocode(addr, country);
            if (!p) this.logger.warn(`dispatch: geocode returned nothing for order ${o.id} ("${addr}")`);
            return p;
          })());
        if (!point) return;
        resolved.set(o.id, point);
        try {
          await this.prisma.order.update({
            where: { id: o.id },
            data: { deliveryLat: point.lat, deliveryLng: point.lng, geocodedAt: new Date() },
          });
        } catch (err) {
          this.logger.warn(`Persist geocode failed for order ${o.id}: ${(err as Error).message}`);
        }
      }),
    );
    return resolved;
  }

  private async locationPin(loc: {
    id: string;
    name: string;
    addressLine1: string | null;
    city: string | null;
    postcode: string | null;
    country?: string | null;
  }): Promise<DispatchLocationPin> {
    const cached = this.locationGeoCache.get(loc.id);
    if (cached) return { id: loc.id, name: loc.name, lat: cached.lat, lng: cached.lng };
    const cc = String(loc.country || "GB").trim().toUpperCase();
    const parts = [loc.addressLine1, loc.city, loc.postcode].filter(Boolean) as string[];
    const point = parts.length
      ? await this.geocoder.geocode(`${parts.join(", ")}, ${cc}`, cc)
      : null;
    if (point) this.locationGeoCache.set(loc.id, point);
    return { id: loc.id, name: loc.name, lat: point?.lat ?? null, lng: point?.lng ?? null };
  }

  /**
   * Location-scoped dispatch feed: location pin(s), live order pins (with the
   * deadline that drives the countdown/colour), and online driver dots.
   * `locationParam` = a specific location id, or "all"/undefined for every
   * location the user can access.
   */
  async getFeed(user: AuthenticatedUser, locationParam?: string): Promise<DispatchFeed> {
    const accessible = await this.resolveAccessibleLocationIds(user);
    const specificLocation = !!locationParam && locationParam !== "all";
    let scope: string[];
    if (!specificLocation) {
      scope = accessible;
    } else {
      if (!accessible.includes(locationParam!)) {
        throw new ForbiddenException("No access to that location");
      }
      scope = [locationParam!];
    }
    if (scope.length === 0) {
      return { scope: [], locations: [], orders: [], drivers: [], couriers: [] };
    }

    // Team Roles decides which shops a driver works at.
    const dashboardDriverIds = await driverIdsForLocations(
      this.prisma,
      user.tenantId,
      scope,
    );

    const orderSelect = {
      id: true,
      displayId: true,
      orderNumber: true,
      status: true,
      platform: true,
      deliveryType: true,
      locationId: true,
      customerName: true,
      total: true,
      paymentMethod: true,
      deliveryLat: true,
      deliveryLng: true,
      courierLat: true,
      courierLng: true,
      courierLocationAt: true,
      courierName: true,
      courierPhone: true,
      courierStatus: true,
      addressLine1: true,
      city: true,
      postcode: true,
      deliveryAddress: true,
      scheduledFor: true,
      estimatedReadyAt: true,
      preparationMinutes: true,
      createdAt: true,
    } as const;
    const doneSince = new Date(Date.now() - 10 * 60_000); // grey window: 10 min
    // Live board only shows recent orders — drop stale ones stuck in an active
    // status (e.g. an old test order left in RIDER_ARRIVED) so they don't linger.
    const liveSince = new Date(Date.now() - 24 * 60 * 60_000);

    const [locationRows, orderRows, doneRows, presenceRows] = await Promise.all([
      this.prisma.location.findMany({
        where: { id: { in: scope } },
        select: {
          id: true,
          name: true,
          addressLine1: true,
          city: true,
          postcode: true,
          country: true,
        },
      }),
      this.prisma.order.findMany({
        where: {
          tenantId: user.tenantId,
          locationId: { in: scope },
          status: { in: ACTIVE_DISPATCH_STATUSES },
          fulfillmentType: { in: DELIVERY_FULFILLMENTS },
          createdAt: { gte: liveSince },
        },
        select: orderSelect,
        orderBy: { createdAt: "asc" },
      }),
      // Recently-delivered orders — shown grey for 10 min, then they drop off.
      this.prisma.order.findMany({
        where: {
          tenantId: user.tenantId,
          locationId: { in: scope },
          status: OrderStatus.COMPLETED,
          fulfillmentType: { in: DELIVERY_FULFILLMENTS },
          updatedAt: { gte: doneSince },
        },
        select: orderSelect,
        orderBy: { updatedAt: "desc" },
      }),
      // Which online drivers to show for the selected scope. Their shop is
      // their Team Roles assignment (dashboardDriverIds), so a driver given
      // the DRIVER role and a location appears here immediately — no second
      // assignment on the Fleet tab, which is what nobody knew to do.
      //   * Specific location → ONLY that shop's drivers.
      //   * All locations → every driver across the operator's shops, plus
      //     anyone clocked into one of them (legacy presence fallback).
      this.prisma.driverPresence.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: [DriverPresenceStatus.ONLINE, DriverPresenceStatus.ON_JOB] },
          ...(specificLocation
            ? { driverId: { in: dashboardDriverIds } }
            : {
                OR: [
                  { driverId: { in: dashboardDriverIds } },
                  { locationId: { in: scope } },
                ],
              }),
        },
        include: { driver: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    const countryByLocation = new Map(
      locationRows.map((l) => [l.id, l.country ?? "GB"]),
    );
    const geocoded = await this.geocodeMissing(
      [...orderRows, ...doneRows],
      countryByLocation,
    );

    const locations = await Promise.all(locationRows.map((l) => this.locationPin(l)));

    const toPin = (o: (typeof orderRows)[number], done: boolean): DispatchOrderPin => {
      const point = o.deliveryLat != null ? { lat: o.deliveryLat, lng: o.deliveryLng } : geocoded.get(o.id);
      const deadline = this.deadlineFor(o);
      return {
        id: o.id,
        displayId: o.displayId,
        orderNumber: o.orderNumber,
        status: o.status,
        platform: o.platform,
        deliveryType: o.deliveryType,
        locationId: o.locationId,
        customerName: o.customerName,
        total: o.total.toString(),
        paymentMethod: o.paymentMethod,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        deadlineAt: deadline ? deadline.toISOString() : null,
        createdAt: o.createdAt.toISOString(),
        done,
        assigned: ASSIGNED_STATUSES.includes(o.status),
      };
    };

    const orders: DispatchOrderPin[] = [
      ...orderRows.map((o) => toPin(o, false)),
      ...doneRows.map((o) => toPin(o, true)),
    ];

    const drivers: DispatchDriverDot[] = presenceRows.map((p) => ({
      driverId: p.driverId,
      name: `${p.driver.firstName} ${p.driver.lastName}`.trim(),
      status: p.status,
      locationId: p.locationId,
      lat: p.lat,
      lng: p.lng,
      heading: p.heading,
      activeAssignmentId: p.activeAssignmentId,
      lastPingAt: p.lastPingAt ? p.lastPingAt.toISOString() : null,
    }));

    // Third-party riders, from whatever position their provider last sent.
    // Anything older than STALE_COURIER_MIN is dropped rather than drawn.
    const nowMs = Date.now();
    const couriers: DispatchCourierPin[] = orderRows
      .filter(
        (o: any) =>
          o.courierLat != null && o.courierLng != null && o.courierLocationAt,
      )
      .map((o: any) => ({
        orderId: o.id,
        ref: o.displayId ?? (o.orderNumber != null ? `#${o.orderNumber}` : null),
        platform: o.platform,
        name: o.courierName ?? null,
        phone: o.courierPhone ?? null,
        status: o.courierStatus ?? null,
        lat: o.courierLat,
        lng: o.courierLng,
        seenAt: o.courierLocationAt.toISOString(),
        ageMinutes: Math.round(
          (nowMs - new Date(o.courierLocationAt).getTime()) / 60_000,
        ),
      }))
      .filter((c: DispatchCourierPin) => c.ageMinutes <= STALE_COURIER_MIN);

    return { scope, locations, orders, drivers, couriers };
  }

  /**
   * One order's geography, for the Map button on the orders board: the shop it
   * leaves from, where it is going, and the rider carrying it if there is one.
   *
   * This is the dispatch map narrowed to a single order — an operator looking
   * at an order wants "where is this going, and how far is it" without leaving
   * the board and hunting for the pin among fifty others.
   *
   * Coordinates come from exactly the same resolution the map feed uses
   * (payload coords → geocode → persisted on the order), so the two views can
   * never disagree about where an order is, and a lookup paid for here is
   * cached for the map and vice versa.
   */
  async getOrderMap(
    user: AuthenticatedUser,
    orderId: string,
  ): Promise<OrderMapView> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      select: {
        id: true,
        displayId: true,
        orderNumber: true,
        status: true,
        customerName: true,
        locationId: true,
        deliveryLat: true,
        deliveryLng: true,
        deliveryAddress: true,
        addressLine1: true,
        city: true,
        postcode: true,
        courierLat: true,
        courierLng: true,
        courierLocationAt: true,
        courierName: true,
        location: {
          select: {
            id: true,
            name: true,
            addressLine1: true,
            city: true,
            postcode: true,
            country: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Same scoping as every other read here: the tenant match above is not
    // enough, a manager must only see their own shops' orders.
    const accessible = await this.resolveAccessibleLocationIds(user);
    if (!order.locationId || !accessible.includes(order.locationId)) {
      throw new ForbiddenException("Order is not in one of your locations");
    }

    const country = order.location?.country ?? "GB";
    const resolved = await this.geocodeMissing(
      [order],
      new Map([[order.locationId, country]]),
    );
    const point =
      order.deliveryLat != null && order.deliveryLng != null
        ? { lat: order.deliveryLat, lng: order.deliveryLng }
        : (resolved.get(order.id) ?? null);

    const shop = order.location
      ? await this.locationPin(order.location)
      : null;

    return {
      order: {
        id: order.id,
        ref:
          order.displayId ??
          (order.orderNumber != null ? `#${order.orderNumber}` : null),
        status: order.status,
        customerName: order.customerName,
        address: this.orderAddressString(order, country),
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
      },
      shop: {
        id: shop?.id ?? order.locationId,
        name: shop?.name ?? "Shop",
        address:
          [order.location?.addressLine1, order.location?.city, order.location?.postcode]
            .filter(Boolean)
            .join(", ") || null,
        lat: shop?.lat ?? null,
        lng: shop?.lng ?? null,
      },
      rider: await this.riderPinFor(order),
    };
  }

  /**
   * Whoever is carrying the order right now, own-fleet or third-party.
   *
   * Own drivers are looked up through their live assignment; third-party
   * riders come from the courier columns the provider webhooks write (this is
   * what draws the Stuart / Deliveroo rider on the dispatch map). Both carry
   * how old the fix is, and a third-party position past STALE_COURIER_MIN is
   * dropped rather than drawn — the same honesty rule the map feed applies,
   * because a stale pin is worse than none.
   */
  private async riderPinFor(order: {
    id: string;
    courierLat: number | null;
    courierLng: number | null;
    courierLocationAt: Date | null;
    courierName: string | null;
  }): Promise<OrderMapRider | null> {
    const age = (at: Date) => Math.round((Date.now() - at.getTime()) / 60_000);

    const assignment = await this.prisma.driverAssignment.findFirst({
      where: {
        orderId: order.id,
        status: {
          in: [
            DriverAssignmentStatus.ASSIGNED,
            DriverAssignmentStatus.ACCEPTED,
            DriverAssignmentStatus.PICKED_UP,
          ],
        },
      },
      select: {
        driver: {
          select: {
            firstName: true,
            lastName: true,
            presence: {
              select: { lat: true, lng: true, lastPingAt: true },
            },
          },
        },
      },
    });
    const presence = assignment?.driver.presence;
    if (presence?.lat != null && presence.lng != null) {
      return {
        kind: "DRIVER",
        name: `${assignment!.driver.firstName} ${assignment!.driver.lastName}`.trim(),
        lat: presence.lat,
        lng: presence.lng,
        seenAt: presence.lastPingAt ? presence.lastPingAt.toISOString() : null,
        ageMinutes: presence.lastPingAt ? age(presence.lastPingAt) : null,
      };
    }

    if (
      order.courierLat != null &&
      order.courierLng != null &&
      order.courierLocationAt
    ) {
      const ageMinutes = age(order.courierLocationAt);
      if (ageMinutes <= STALE_COURIER_MIN) {
        return {
          kind: "COURIER",
          name: order.courierName ?? null,
          lat: order.courierLat,
          lng: order.courierLng,
          seenAt: order.courierLocationAt.toISOString(),
          ageMinutes,
        };
      }
    }

    return null;
  }

  /**
   * Own-fleet dispatch: assign an ordered list of orders to one driver as a
   * multi-drop run. orderIds[] are in the operator's chosen stop order →
   * sequence 1..N. Marks orders ASSIGNED_DRIVER, flips the driver ON_JOB, and
   * pushes one new-job alert (Accept/Reject).
   */
  async assignToDriver(user: AuthenticatedUser, driverId: string, orderIds: string[]) {
    if (!orderIds?.length) throw new BadRequestException("No orders selected");

    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!driver) throw new NotFoundException("Driver not found");

    const presence = await this.prisma.driverPresence.findUnique({
      where: { driverId },
      select: { pushToken: true },
    });

    let seq = 1;
    let firstAssignmentId: string | null = null;
    for (const orderId of orderIds) {
      const order = await this.prisma.order.findFirst({
        where: { id: orderId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!order) continue;
      const a = await this.prisma.driverAssignment.upsert({
        where: { orderId },
        create: { orderId, driverId, status: DriverAssignmentStatus.ASSIGNED, sequence: seq },
        update: {
          driverId,
          status: DriverAssignmentStatus.ASSIGNED,
          sequence: seq,
          assignedAt: new Date(),
          acceptedAt: null,
          pickedUpAt: null,
          arrivedAt: null,
          deliveredAt: null,
        },
      });
      firstAssignmentId = firstAssignmentId ?? a.id;
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.ASSIGNED_DRIVER },
      });
      seq += 1;
    }

    await this.prisma.driverPresence
      .update({
        where: { driverId },
        data: { status: DriverPresenceStatus.ON_JOB, activeAssignmentId: firstAssignmentId },
      })
      .catch(() => undefined);

    const n = orderIds.length;
    await this.expoPush.sendNewJob(presence?.pushToken, {
      orderId: orderIds[0] ?? "",
      title: "New delivery run",
      body: `${n} ${n === 1 ? "order" : "orders"} assigned to you — Accept or Reject`,
    });

    return { ok: true, count: n };
  }

  /** Remove an order from its driver and return it to the board for re-dispatch. */
  async unassign(user: AuthenticatedUser, orderId: string) {
    const a = await this.prisma.driverAssignment.findUnique({
      where: { orderId },
      select: { id: true, driverId: true },
    });
    if (!a) return { ok: true };

    // Tenant guard via the order.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!order) throw new ForbiddenException("No access to that order");

    await this.prisma.driverAssignment.update({
      where: { orderId },
      data: { status: DriverAssignmentStatus.CANCELLED },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.READY },
    });

    const remaining = await this.prisma.driverAssignment.count({
      where: {
        driverId: a.driverId,
        status: {
          in: [
            DriverAssignmentStatus.ASSIGNED,
            DriverAssignmentStatus.ACCEPTED,
            DriverAssignmentStatus.PICKED_UP,
          ],
        },
      },
    });
    if (remaining === 0) {
      await this.prisma.driverPresence
        .update({
          where: { driverId: a.driverId },
          data: { status: DriverPresenceStatus.ONLINE, activeAssignmentId: null },
        })
        .catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * Operator dashboard: location-scoped delivery analytics + a tenant-wide
   * driver roster with per-driver active jobs and today's cash-up. Orders are
   * scoped to the selected location(s); drivers are the whole fleet (they aren't
   * bound to one location), mirroring the dispatch map.
   */
  async getOperatorDashboard(
    user: AuthenticatedUser,
    locationParam?: string,
  ): Promise<OperatorDashboard> {
    const accessible = await this.resolveAccessibleLocationIds(user);
    let scope: string[];
    if (!locationParam || locationParam === "all") {
      scope = accessible;
    } else {
      if (!accessible.includes(locationParam)) {
        throw new ForbiddenException("No access to that location");
      }
      scope = [locationParam];
    }
    const emptyStats: OperatorStats = {
      online: 0,
      busy: 0,
      outForDelivery: 0,
      deliveredToday: 0,
      attention: 0,
      failedToday: 0,
    };
    if (scope.length === 0) {
      return { scope: [], stats: emptyStats, attention: [], outForDelivery: [], drivers: [], recentFailed: [] };
    }

    // Team Roles decides which shops a driver works at — the same resolve the
    // map and Fleet use, so the three boards can't disagree.
    const dashboardDriverIds = await driverIdsForLocations(
      this.prisma,
      user.tenantId,
      scope,
    );

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const liveSince = new Date(Date.now() - 24 * 60 * 60_000);
    const now = Date.now();
    const ref = (o: { displayId: string | null; orderNumber: number | null }, id: string) =>
      `#${o.displayId ?? o.orderNumber ?? id.slice(-5)}`;
    // Marketplace orders arrive through a webhook and their address lands in
    // the deliveryAddress JSON, not always in the flat columns. This helper
    // read only the flat three, so a Deliveroo or Uber delivery showed
    // "No address" on the operator board while the same order had a perfectly
    // good pin on the map — the map walks the JSON too.
    //
    // orderAddressString is that walk, already written and already used by the
    // geocoder, so the board and the map now answer from the same place.
    const addr = (o: {
      addressLine1: string | null;
      city: string | null;
      postcode: string | null;
      deliveryAddress?: unknown;
    }) => {
      const flat = [o.addressLine1, o.city, o.postcode].filter(Boolean).join(", ");
      if (flat) return flat;
      const full = this.orderAddressString(
        {
          addressLine1: o.addressLine1,
          city: o.city,
          postcode: o.postcode,
          deliveryAddress: o.deliveryAddress ?? null,
        },
        "",
      );
      // orderAddressString appends the shop's country for the geocoder; the
      // board is for a human reading it at a glance, so trim the trailing
      // separator that leaves behind.
      return full ? full.replace(/,\s*$/, "") : null;
    };

    const [activeOrders, deliveredToday, failedRows, drivers] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          tenantId: user.tenantId,
          locationId: { in: scope },
          fulfillmentType: { in: DELIVERY_FULFILLMENTS },
          status: { in: ACTIVE_DISPATCH_STATUSES },
          createdAt: { gte: liveSince },
        },
        select: {
          id: true,
          displayId: true,
          orderNumber: true,
          customerName: true,
          status: true,
          scheduledFor: true,
          estimatedReadyAt: true,
          preparationMinutes: true,
          createdAt: true,
          addressLine1: true,
          city: true,
          postcode: true,
          deliveryAddress: true,
          driverAssignment: { select: { driver: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.order.count({
        where: {
          tenantId: user.tenantId,
          locationId: { in: scope },
          fulfillmentType: { in: DELIVERY_FULFILLMENTS },
          status: OrderStatus.COMPLETED,
          updatedAt: { gte: startOfDay },
        },
      }),
      this.prisma.order.findMany({
        where: {
          tenantId: user.tenantId,
          locationId: { in: scope },
          fulfillmentType: { in: DELIVERY_FULFILLMENTS },
          status: { in: [OrderStatus.FAILED, OrderStatus.CANCELLED] },
          updatedAt: { gte: startOfDay },
        },
        select: {
          id: true,
          displayId: true,
          orderNumber: true,
          customerName: true,
          status: true,
          failureReason: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.driver.findMany({
        // Where a driver works is their Team Roles assignment, resolved above
        // into dashboardDriverIds — one answer, the same one Fleet and the map
        // use, so a driver can't be on one board and missing from another.
        where: {
          tenantId: user.tenantId,
          isActive: true,
          id: { in: dashboardDriverIds },
        },
        include: {
          presence: { select: { status: true, lastPingAt: true } },
          assignments: {
            where: {
              OR: [
                {
                  status: {
                    in: [
                      DriverAssignmentStatus.ASSIGNED,
                      DriverAssignmentStatus.ACCEPTED,
                      DriverAssignmentStatus.PICKED_UP,
                    ],
                  },
                },
                { status: DriverAssignmentStatus.DELIVERED, deliveredAt: { gte: startOfDay } },
              ],
            },
            select: {
              orderId: true,
              status: true,
              sequence: true,
              order: {
                select: {
                  displayId: true,
                  orderNumber: true,
                  customerName: true,
                  total: true,
                  paymentMethod: true,
                  addressLine1: true,
                  city: true,
                  postcode: true,
                  deliveryAddress: true,
                },
              },
            },
            orderBy: { sequence: "asc" },
          },
        },
        orderBy: { firstName: "asc" },
      }),
    ]);

    // Build the order rows (attention = overdue + still active).
    const toRow = (o: (typeof activeOrders)[number]): OperatorOrderRow => {
      const deadline = this.deadlineFor(o);
      const late = deadline ? Math.round((now - deadline.getTime()) / 60_000) : null;
      const d = o.driverAssignment?.driver;
      return {
        id: o.id,
        ref: ref(o, o.id),
        customerName: o.customerName,
        status: o.status,
        deadlineAt: deadline ? deadline.toISOString() : null,
        minutesLate: late != null && late > 0 ? late : null,
        driverName: d ? `${d.firstName} ${d.lastName}`.trim() : null,
        address: addr(o),
      };
    };
    const attention = activeOrders
      .map(toRow)
      .filter((r) => r.minutesLate != null)
      .sort((a, b) => (b.minutesLate ?? 0) - (a.minutesLate ?? 0));
    const outForDelivery = activeOrders
      .filter((o) => OUT_FOR_DELIVERY_STATUSES.includes(o.status))
      .map(toRow);

    // Phase BG — show EVERY driver of the location (not just online ones) so
    // the operator can open Manage and set up pay for any of them.
    const driverRows: OperatorDriverRow[] = drivers.map((d) => {
      const active = d.assignments.filter((a) => a.status !== DriverAssignmentStatus.DELIVERED);
      const delivered = d.assignments.filter((a) => a.status === DriverAssignmentStatus.DELIVERED);
      const fees = coercePostcodeFees((d as any).postcodeFees);
      let cash = 0;
      let card = 0;
      let deliveryFees = 0;
      for (const a of delivered) {
        const t = Number(a.order.total);
        const method = (a.order.paymentMethod ?? "").toUpperCase();
        if (method.includes("CASH") || method === "") cash += t;
        else card += t;
        deliveryFees += matchPostcodeFee(fees, a.order.postcode);
      }
      const startup = Number((d as any).startupFee) || 0;
      const earningToday = (delivered.length > 0 ? startup : 0) + deliveryFees;
      return {
        id: d.id,
        name: `${d.firstName} ${d.lastName}`.trim(),
        status: d.presence?.status ?? DriverPresenceStatus.OFFLINE,
        lastPingAt: d.presence?.lastPingAt ? d.presence.lastPingAt.toISOString() : null,
        activeJobs: active.map((a) => ({
          orderId: a.orderId,
          ref: ref(a.order, a.orderId),
          customerName: a.order.customerName,
          status: a.status,
          sequence: a.sequence,
          address: addr(a.order),
        })),
        delivered: delivered.length,
        cashTotal: cash.toFixed(2),
        cardTotal: card.toFixed(2),
        total: (cash + card).toFixed(2),
        homeLocationId: (d as any).locationId ?? null,
        startupFee: startup.toFixed(2),
        postcodeFees: fees,
        earningToday: earningToday.toFixed(2),
      };
    });

    const stats: OperatorStats = {
      online: driverRows.filter((d) => d.status === DriverPresenceStatus.ONLINE).length,
      busy: driverRows.filter((d) => d.status === DriverPresenceStatus.ON_JOB).length,
      outForDelivery: outForDelivery.length,
      deliveredToday,
      attention: attention.length,
      failedToday: failedRows.length,
    };

    const recentFailed: OperatorFailedRow[] = failedRows.map((o) => ({
      id: o.id,
      ref: ref(o, o.id),
      customerName: o.customerName,
      status: o.status,
      reason: o.failureReason,
      at: o.updatedAt.toISOString(),
    }));

    return { scope, stats, attention, outForDelivery, drivers: driverRows, recentFailed };
  }
}
