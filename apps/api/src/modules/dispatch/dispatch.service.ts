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

const ADMIN_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER"];
const DEFAULT_PREP_MINUTES = 20;

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

export interface DispatchFeed {
  scope: string[];
  locations: DispatchLocationPin[];
  orders: DispatchOrderPin[];
  drivers: DispatchDriverDot[];
}

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

  /** Locations this user is allowed to see on the dispatch map. */
  private async resolveAccessibleLocationIds(user: AuthenticatedUser): Promise<string[]> {
    if (ADMIN_ROLES.includes(user.role)) {
      // Location is tenant-scoped through its brand (no direct tenantId column).
      const locs = await this.prisma.location.findMany({
        where: { brand: { tenantId: user.tenantId } },
        select: { id: true },
      });
      return locs.map((l) => l.id);
    }
    const access = await this.prisma.userLocation.findMany({
      where: { userId: user.userId },
      select: { locationId: true },
    });
    return access.map((a) => a.locationId);
  }

  /** Build a free-form address string from an order's structured + JSON fields. */
  private orderAddressString(order: {
    addressLine1: string | null;
    city: string | null;
    postcode: string | null;
    deliveryAddress: unknown;
  }): string | null {
    const parts = [order.addressLine1, order.city, order.postcode].filter(Boolean) as string[];
    if (parts.length) return `${parts.join(", ")}, UK`;
    // Fallback to the deliveryAddress JSON blob (webhook-ingested shapes).
    const a = order.deliveryAddress as Record<string, unknown> | null;
    if (a && typeof a === "object") {
      const jsonParts = [
        a.line1 ?? a.addressLine1 ?? a.address1 ?? a.street,
        a.city ?? a.town,
        a.postcode ?? a.postal_code ?? a.zip,
      ].filter(Boolean) as string[];
      if (jsonParts.length) return `${jsonParts.join(", ")}, UK`;
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

  /** Many platform payloads (Deliveroo/HubRise) carry the customer lat/lng
   *  directly in deliveryAddress — use those before paying to geocode. */
  private coordsFromAddress(deliveryAddress: unknown): { lat: number; lng: number } | null {
    const a = deliveryAddress as Record<string, unknown> | null;
    if (!a || typeof a !== "object") return null;
    const lat = Number(a.lat ?? a.latitude ?? (a as Record<string, unknown>).Latitude);
    const lng = Number(a.lng ?? a.lon ?? a.longitude ?? (a as Record<string, unknown>).Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      return { lat, lng };
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
  ): Promise<Map<string, { lat: number; lng: number }>> {
    const resolved = new Map<string, { lat: number; lng: number }>();
    const missing = orders.filter((o) => o.deliveryLat == null);
    await Promise.all(
      missing.map(async (o) => {
        const point =
          this.coordsFromAddress(o.deliveryAddress) ??
          (await (async () => {
            const addr = this.orderAddressString(o);
            if (!addr) {
              this.logger.log(`dispatch: order ${o.id} has no geocodable address/coords — no pin`);
              return null;
            }
            const p = await this.geocoder.geocode(addr);
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
  }): Promise<DispatchLocationPin> {
    const cached = this.locationGeoCache.get(loc.id);
    if (cached) return { id: loc.id, name: loc.name, lat: cached.lat, lng: cached.lng };
    const parts = [loc.addressLine1, loc.city, loc.postcode].filter(Boolean) as string[];
    const point = parts.length ? await this.geocoder.geocode(`${parts.join(", ")}, UK`) : null;
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
    let scope: string[];
    if (!locationParam || locationParam === "all") {
      scope = accessible;
    } else {
      if (!accessible.includes(locationParam)) {
        throw new ForbiddenException("No access to that location");
      }
      scope = [locationParam];
    }
    if (scope.length === 0) {
      return { scope: [], locations: [], orders: [], drivers: [] };
    }

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
        select: { id: true, name: true, addressLine1: true, city: true, postcode: true },
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
      // Drivers are a tenant-wide fleet, not bound to one location, so we scope
      // them by tenant only — NOT by the selected order-location scope. (A driver
      // goes online pinned to the tenant's oldest location; filtering by scope
      // would hide them whenever the operator views a different location, which
      // is why "0 drivers online" showed even though the Fleet tab listed them.)
      this.prisma.driverPresence.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: [DriverPresenceStatus.ONLINE, DriverPresenceStatus.ON_JOB] },
        },
        include: { driver: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    const geocoded = await this.geocodeMissing([...orderRows, ...doneRows]);

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

    return { scope, locations, orders, drivers };
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
}
