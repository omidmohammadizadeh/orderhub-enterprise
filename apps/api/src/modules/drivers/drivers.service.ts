import { Injectable, NotFoundException, ConflictException, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

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
  ) {}

  async findAll(tenantId: string, activeOnly = true) {
    return this.prisma.driver.findMany({
      where: { tenantId, ...(activeOnly ? { isActive: true } : {}) },
      include: {
        _count: { select: { assignments: true } },
        assignments: {
          where: { status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] } },
          select: { id: true, status: true, orderId: true },
          take: 1,
        },
      },
      orderBy: { firstName: "asc" },
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
