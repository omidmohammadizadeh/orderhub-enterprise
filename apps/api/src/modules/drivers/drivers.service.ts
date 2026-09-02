import { Injectable, NotFoundException, ConflictException, Logger } from "@nestjs/common";
import {
  accessibleLocationIds,
  driverIdsForLocations,
} from "../../common/access/accessible-locations";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { ExpoPushService } from "../driver-app/expo-push.service";
import { DriverPresenceStatus } from "@orderhub/database";

export interface CreateDriverDto {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  vehicleType?: string;
  userId?: string;
}

export interface UpdateDriverDto {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  vehicleType?: string;
  isActive?: boolean;
}

export interface AssignDriverDto {
  driverId: string;
  orderId: string;
}

export interface TrackingEventDto {
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  event?: string;
}

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly expoPush: ExpoPushService,
  ) {}

  /**
   * The drivers this operator may see, optionally narrowed to one shop.
   *
   * This used to return every driver in the tenant, so a manager at one shop
   * opened Fleet and saw every other shop's drivers — and could set them
   * online or move them.
   *
   * With a shop picked, ONLY drivers homed at that shop are listed. This
   * mirrors the dispatch map exactly, which has always worked that way: a
   * driver with no home location does not appear under a shop, and assigning
   * their location is what makes them show.
   *
   * Drivers with no home are still listed under "All locations", which is
   * where a stray gets found and assigned. Without that they would be
   * invisible everywhere and impossible to fix.
   */
  async findAll(
    user: Pick<AuthenticatedUser, "userId" | "tenantId" | "role">,
    opts: { activeOnly?: boolean; locationId?: string } = {},
  ) {
    const activeOnly = opts.activeOnly ?? true;
    const tenantId = user.tenantId;
    const allowed = await accessibleLocationIds(this.prisma, user);

    // The id comes from a picker in the browser, so it may only ever narrow
    // what the caller's own assignments already allow.
    if (opts.locationId && !allowed.includes(opts.locationId)) return [];
    if (allowed.length === 0) return [];

    // Where a driver works comes from Team Roles now, not from a second
    // location picked on this screen. Assigning the DRIVER role and the
    // locations there is the whole job; Fleet reflects it.
    const ids = await driverIdsForLocations(
      this.prisma,
      tenantId,
      opts.locationId ? [opts.locationId] : allowed,
    );
    const scope = opts.locationId
      ? { id: { in: ids } }
      : // "All locations" also lists anyone Team Roles can't place — a driver
        // record with no login attached. They belong to no shop, so they never
        // appear under one, but hiding them everywhere would leave a row
        // nobody could see to clean up.
        { OR: [{ id: { in: ids } }, { userId: null }] };

    const rows = await this.prisma.driver.findMany({
      where: { tenantId, ...(activeOnly ? { isActive: true } : {}), ...scope },
      include: {
        _count: { select: { assignments: true } },
        assignments: {
          where: { status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] } },
          select: { id: true, status: true, orderId: true },
          take: 1,
        },
        presence: { select: { status: true, locationId: true, lastPingAt: true } },
      },
      orderBy: { firstName: "asc" },
    });

    // Where each driver works, for the column that used to be a dropdown.
    // Read, not editable: Team Roles is where this is set, and offering a
    // second place to set it is what created the bug — a driver assigned
    // there stayed off their shop's map until somebody set it again here.
    const userIds = rows
      .map((d) => d.userId)
      .filter((id): id is string => !!id);
    const links = userIds.length
      ? await this.prisma.userLocation.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, location: { select: { name: true } } },
        })
      : [];
    const namesByUser = new Map<string, string[]>();
    for (const l of links) {
      const list = namesByUser.get(l.userId) ?? [];
      list.push(l.location.name);
      namesByUser.set(l.userId, list);
    }

    return rows.map((d) => ({
      ...d,
      locationNames: d.userId ? (namesByUser.get(d.userId) ?? []) : [],
    }));
  }

  /** Operator toggles a driver online/offline from the Fleet tab. */
  async setPresence(tenantId: string, driverId: string, online: boolean) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId },
      select: { id: true },
    });
    if (!driver) throw new NotFoundException("Driver not found");

    let locationId: string | null = null;
    if (online) {
      const loc = await this.prisma.location.findFirst({
        where: { brand: { tenantId } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      locationId = loc?.id ?? null;
    }

    return this.prisma.driverPresence.upsert({
      where: { driverId },
      create: {
        driverId,
        tenantId,
        status: online ? DriverPresenceStatus.ONLINE : DriverPresenceStatus.OFFLINE,
        locationId,
      },
      update: online
        ? { status: DriverPresenceStatus.ONLINE, locationId, lastPingAt: new Date() }
        : { status: DriverPresenceStatus.OFFLINE, locationId: null, activeAssignmentId: null },
    });
  }

  async findOne(driverId: string, tenantId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId },
      include: {
        assignments: {
          orderBy: { assignedAt: "desc" },
          take: 10,
          include: {
            order: { select: { id: true, displayId: true, status: true, createdAt: true } },
          },
        },
      },
    });
    if (!driver) throw new NotFoundException("Driver not found");
    return driver;
  }

  async create(tenantId: string, dto: CreateDriverDto) {
    return this.prisma.driver.create({
      data: {
        tenantId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        email: dto.email ?? null,
        vehicleType: dto.vehicleType ?? null,
        userId: dto.userId ?? null,
      },
    });
  }

  async update(driverId: string, tenantId: string, dto: UpdateDriverDto) {
    await this.assertAccess(driverId, tenantId);
    return this.prisma.driver.update({
      where: { id: driverId },
      data: {
        ...(dto.firstName && { firstName: dto.firstName }),
        ...(dto.lastName && { lastName: dto.lastName }),
        ...(dto.phone && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.vehicleType !== undefined && { vehicleType: dto.vehicleType }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async assignDriver(tenantId: string, dto: AssignDriverDto) {
    // Validate order belongs to tenant
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Validate driver belongs to tenant
    await this.assertAccess(dto.driverId, tenantId);

    // Upsert assignment (re-assign overrides previous)
    const assignment = await this.prisma.driverAssignment.upsert({
      where: { orderId: dto.orderId },
      create: {
        orderId: dto.orderId,
        driverId: dto.driverId,
        status: "ASSIGNED",
      },
      update: {
        driverId: dto.driverId,
        status: "ASSIGNED",
        assignedAt: new Date(),
        acceptedAt: null,
        pickedUpAt: null,
        deliveredAt: null,
      },
      include: {
        driver: { select: { id: true, firstName: true, lastName: true, phone: true } },
        order: { select: { id: true, displayId: true, locationId: true } },
      },
    });

    // Notify location room — cast as any: assignment includes joined relations
    // beyond the minimal DriverAssignedPayload interface shape
    this.socket.emitToLocation(
      assignment.order.locationId,
      "dispatch:driver:assigned",
      assignment as any,
    );

    // Push the new-job alert (with Accept / Reject buttons) to the driver's
    // device — fires even when the driver app is closed.
    const presence = await this.prisma.driverPresence.findUnique({
      where: { driverId: dto.driverId },
      select: { pushToken: true },
    });
    await this.expoPush.sendNewJob(presence?.pushToken, {
      orderId: dto.orderId,
      title: "New delivery waiting",
      body: `Order #${assignment.order.displayId ?? dto.orderId.slice(-5)} is waiting for you — Accept or Reject`,
    });

    return assignment;
  }

  async updateAssignmentStatus(
    orderId: string,
    tenantId: string,
    status: "ACCEPTED" | "PICKED_UP" | "DELIVERED" | "CANCELLED",
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { locationId: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    const timestampField: Record<string, string> = {
      ACCEPTED: "acceptedAt",
      PICKED_UP: "pickedUpAt",
      DELIVERED: "deliveredAt",
    };

    const assignment = await this.prisma.driverAssignment.update({
      where: { orderId },
      data: {
        status,
        ...(timestampField[status] ? { [timestampField[status]]: new Date() } : {}),
      },
      include: {
        driver: { select: { firstName: true, lastName: true, phone: true } },
      },
    });

    this.socket.emitToLocation(order.locationId, "dispatch:assignment:updated", {
      orderId,
      status,
      driver: assignment.driver,
    } as any);

    return assignment;
  }

  async recordTracking(orderId: string, tenantId: string, dto: TrackingEventDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { locationId: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    const assignment = await this.prisma.driverAssignment.findUnique({
      where: { orderId },
    });
    if (!assignment) throw new NotFoundException("No active driver assignment");

    const tracking = await this.prisma.deliveryTracking.create({
      data: {
        assignmentId: assignment.id,
        lat: dto.lat,
        lng: dto.lng,
        accuracy: dto.accuracy ?? null,
        heading: dto.heading ?? null,
        speed: dto.speed ?? null,
        event: dto.event ?? null,
      },
    });

    // Broadcast real-time location to location room (and optionally customer room)
    // TrackingUpdatePayload uses latitude/longitude; we store lat/lng in DB. Cast as any.
    this.socket.emitToLocation(order.locationId, "dispatch:tracking:update", {
      orderId,
      latitude: dto.lat,
      longitude: dto.lng,
      timestamp: tracking.recordedAt.toISOString(),
      driverId: assignment.driverId,
    });

    return tracking;
  }

  async getTrackingHistory(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    const assignment = await this.prisma.driverAssignment.findUnique({
      where: { orderId },
      include: {
        driver: { select: { firstName: true, lastName: true, phone: true, vehicleType: true } },
        tracking: { orderBy: { recordedAt: "desc" }, take: 200 },
      },
    });
    if (!assignment) return null;
    return assignment;
  }

  private async assertAccess(driverId: string, tenantId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId },
    });
    if (!driver) throw new NotFoundException("Driver not found");
    return driver;
  }
}
