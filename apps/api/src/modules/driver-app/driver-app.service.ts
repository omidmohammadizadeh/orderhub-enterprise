import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  DriverPresenceStatus,
  DriverAssignmentStatus,
  OrderStatus,
} from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export interface PingDto {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
}

export type JobAction = "accept" | "start" | "delivered" | "skip" | "cancel";

// The driver-facing API. Every endpoint resolves the *current* Driver from the
// authenticated user (Driver.userId), so a driver only ever sees/acts on their
// own presence + assignments. The operator-side CRUD stays in DriversModule.
@Injectable()
export class DriverAppService {
  private readonly logger = new Logger(DriverAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async resolveDriver(user: AuthenticatedUser) {
    const driver = await this.prisma.driver.findFirst({
      where: { userId: user.userId, tenantId: user.tenantId },
    });
    if (!driver) {
      throw new NotFoundException("No driver profile is linked to this account");
    }
    return driver;
  }

  private async upsertPresence(
    driver: { id: string; tenantId: string },
    data: Record<string, unknown>,
  ) {
    return this.prisma.driverPresence.upsert({
      where: { driverId: driver.id },
      create: { driverId: driver.id, tenantId: driver.tenantId, ...data },
      update: data,
    });
  }

  async goOnline(user: AuthenticatedUser, locationId: string) {
    const driver = await this.resolveDriver(user);
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId: user.tenantId } },
      select: { id: true },
    });
    if (!loc) throw new BadRequestException("Unknown location");
    return this.upsertPresence(driver, {
      status: DriverPresenceStatus.ONLINE,
      locationId,
      lastPingAt: new Date(),
    });
  }

  async goOffline(user: AuthenticatedUser) {
    const driver = await this.resolveDriver(user);
    return this.upsertPresence(driver, {
      status: DriverPresenceStatus.OFFLINE,
      locationId: null,
      activeAssignmentId: null,
    });
  }

  async ping(user: AuthenticatedUser, dto: PingDto) {
    const driver = await this.resolveDriver(user);
    return this.upsertPresence(driver, {
      lat: dto.lat,
      lng: dto.lng,
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      lastPingAt: new Date(),
    });
  }

  async registerPushToken(user: AuthenticatedUser, token: string) {
    const driver = await this.resolveDriver(user);
    await this.upsertPresence(driver, { pushToken: token });
    return { ok: true };
  }

  async me(user: AuthenticatedUser) {
    const driver = await this.resolveDriver(user);
    const presence = await this.prisma.driverPresence.findUnique({
      where: { driverId: driver.id },
    });
    return {
      id: driver.id,
      firstName: driver.firstName,
      lastName: driver.lastName,
      phone: driver.phone,
      vehicleType: driver.vehicleType,
      presence,
    };
  }

  /** Today's active jobs + recent history + a cash-up summary for today. */
  async getMyDay(user: AuthenticatedUser) {
    const driver = await this.resolveDriver(user);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const assignments = await this.prisma.driverAssignment.findMany({
      where: { driverId: driver.id },
      orderBy: { assignedAt: "desc" },
      take: 100,
      include: {
        order: {
          select: {
            id: true,
            displayId: true,
            orderNumber: true,
            status: true,
            customerName: true,
            customerPhone: true,
            total: true,
            paymentMethod: true,
            deliveryAddress: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            postcode: true,
            deliveryLat: true,
            deliveryLng: true,
            specialInstructions: true,
          },
        },
      },
    });

    const ACTIVE: DriverAssignmentStatus[] = [
      DriverAssignmentStatus.ASSIGNED,
      DriverAssignmentStatus.ACCEPTED,
      DriverAssignmentStatus.PICKED_UP,
    ];
    const active = assignments.filter((a) => ACTIVE.includes(a.status));
    const history = assignments.filter((a) => !ACTIVE.includes(a.status));

    // Cash-up: today's delivered jobs, split by cash vs card.
    const deliveredToday = assignments.filter(
      (a) =>
        a.status === DriverAssignmentStatus.DELIVERED &&
        a.deliveredAt &&
        a.deliveredAt >= startOfDay,
    );
    let cashTotal = 0;
    let cardTotal = 0;
    for (const a of deliveredToday) {
      const total = Number(a.order.total);
      const method = (a.order.paymentMethod ?? "").toUpperCase();
      if (method.includes("CASH")) cashTotal += total;
      else cardTotal += total;
    }

    return {
      active,
      history,
      cashUp: {
        deliveries: deliveredToday.length,
        cashTotal: cashTotal.toFixed(2),
        cardTotal: cardTotal.toFixed(2),
        total: (cashTotal + cardTotal).toFixed(2),
      },
    };
  }

  async jobAction(user: AuthenticatedUser, orderId: string, action: JobAction) {
    const driver = await this.resolveDriver(user);
    const assignment = await this.prisma.driverAssignment.findFirst({
      where: { orderId, driverId: driver.id },
    });
    if (!assignment) throw new NotFoundException("No assignment for this order");

    const now = new Date();

    switch (action) {
      case "accept":
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { status: DriverAssignmentStatus.ACCEPTED, acceptedAt: now },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.ACCEPTED_BY_DRIVER },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ON_JOB,
          activeAssignmentId: assignment.id,
        });
        break;

      case "start": // picked up → out for delivery
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { status: DriverAssignmentStatus.PICKED_UP, pickedUpAt: now },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.OUT_FOR_DELIVERY },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ON_JOB,
          activeAssignmentId: assignment.id,
        });
        break;

      case "delivered":
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { status: DriverAssignmentStatus.DELIVERED, deliveredAt: now },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.COMPLETED },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ONLINE,
          activeAssignmentId: null,
        });
        break;

      case "skip": // customer didn't answer — flag the order, free the driver
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { status: DriverAssignmentStatus.CANCELLED },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.FAILED, failureReason: "Customer did not answer" },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ONLINE,
          activeAssignmentId: null,
        });
        break;

      case "cancel": // driver can't complete (incident) — return order to the board
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { status: DriverAssignmentStatus.CANCELLED },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.READY },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ONLINE,
          activeAssignmentId: null,
        });
        break;

      default:
        throw new BadRequestException(`Unknown action: ${action}`);
    }

    return { ok: true, action };
  }
}
