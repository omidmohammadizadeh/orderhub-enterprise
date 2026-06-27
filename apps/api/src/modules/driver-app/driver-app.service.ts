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
import { HubRiseOrderSyncService } from "../integrations/hubrise/hubrise-order-sync.service";
import { ChatService } from "../chat/chat.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export interface PingDto {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
}

export type JobAction = "accept" | "start" | "arrived" | "delivered" | "skip" | "cancel";

// Mirrors DispatchService.deadlineFor: when an order is "due" so the driver app
// can show a minutes-to-deadline countdown that matches the dispatch console.
const DEFAULT_PREP_MINUTES = 20;
function deadlineFor(order: {
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

// The driver-facing API. Every endpoint resolves the *current* Driver from the
// authenticated user (Driver.userId), so a driver only ever sees/acts on their
// own presence + assignments. The operator-side CRUD stays in DriversModule.
@Injectable()
export class DriverAppService {
  private readonly logger = new Logger(DriverAppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseSync: HubRiseOrderSyncService,
    private readonly chat: ChatService,
  ) {}

  // ── Chat ────────────────────────────────────────────────────────────────────
  /** Driver ↔ operator conversation (marks operator messages read). */
  async operatorChat(user: AuthenticatedUser) {
    const driver = await this.resolveDriver(user);
    const messages = await this.chat.driverThread(user.tenantId, driver.id);
    await this.chat.readDriverThread(user.tenantId, driver.id, "DRIVER");
    const unread = 0;
    return { messages, unread };
  }
  async sendOperatorChat(user: AuthenticatedUser, body: string) {
    const driver = await this.resolveDriver(user);
    const name = `${driver.firstName} ${driver.lastName}`.trim();
    return this.chat.postDriverOperator(user.tenantId, driver.id, "DRIVER", body, name);
  }
  async operatorChatUnread(user: AuthenticatedUser) {
    const driver = await this.resolveDriver(user);
    return { unread: await this.chat.driverUnread(user.tenantId, driver.id) };
  }

  /** Driver ↔ customer conversation for one of the driver's orders. */
  async customerChat(user: AuthenticatedUser, orderId: string) {
    const driver = await this.resolveDriver(user);
    const assignment = await this.prisma.driverAssignment.findFirst({
      where: { orderId, driverId: driver.id },
      select: { id: true },
    });
    if (!assignment) throw new NotFoundException("No assignment for this order");
    const messages = await this.chat.customerThread(orderId);
    await this.chat.readCustomerThread(orderId, "DRIVER");
    return { messages };
  }
  async sendCustomerChat(user: AuthenticatedUser, orderId: string, body: string) {
    const driver = await this.resolveDriver(user);
    const assignment = await this.prisma.driverAssignment.findFirst({
      where: { orderId, driverId: driver.id },
      select: { id: true },
    });
    if (!assignment) throw new NotFoundException("No assignment for this order");
    const name = `${driver.firstName}`.trim() || "Driver";
    return this.chat.postCustomerDriver(orderId, "DRIVER", body, name);
  }

  // Driver action → the OrderStatus we push back to HubRise. pushStatus itself
  // no-ops for non-HubRise orders and for statuses HubRise doesn't model
  // (e.g. RIDER_ARRIVED), so it's safe to call for every action.
  private static readonly PUSH_STATUS_BY_ACTION: Record<JobAction, OrderStatus> = {
    accept: OrderStatus.ACCEPTED_BY_DRIVER,
    start: OrderStatus.OUT_FOR_DELIVERY,
    arrived: OrderStatus.RIDER_ARRIVED,
    delivered: OrderStatus.COMPLETED,
    skip: OrderStatus.FAILED,
    cancel: OrderStatus.READY,
  };

  // Resolve the current user to a Driver. If none is linked yet, auto-provision
  // one: adopt an existing unlinked driver with the same email, otherwise create
  // a fresh profile from the user's account. This means any user who signs into
  // the Order Hub Driver app immediately has a usable driver profile.
  private async resolveDriver(user: AuthenticatedUser) {
    const linked = await this.prisma.driver.findFirst({
      where: { userId: user.userId, tenantId: user.tenantId },
    });
    if (linked) return linked;

    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!account) throw new NotFoundException("User not found");

    // Adopt an existing operator-created driver row with the same email.
    const unlinked = await this.prisma.driver.findFirst({
      where: { tenantId: user.tenantId, userId: null, email: account.email },
    });
    if (unlinked) {
      return this.prisma.driver.update({
        where: { id: unlinked.id },
        data: { userId: user.userId },
      });
    }

    return this.prisma.driver.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        phone: "",
        isActive: true,
      },
    });
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

  async goOnline(user: AuthenticatedUser, locationId?: string) {
    const driver = await this.resolveDriver(user);
    // Resolve the location server-side: use the requested one if it belongs to
    // the tenant, otherwise default to the tenant's location. Drivers don't have
    // UserLocation scoping, so they should never need to pick one to go online.
    let resolved: string | null = null;
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, brand: { tenantId: user.tenantId } },
        select: { id: true },
      });
      resolved = loc?.id ?? null;
    }
    if (!resolved) {
      const fallback = await this.prisma.location.findFirst({
        where: { brand: { tenantId: user.tenantId } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      resolved = fallback?.id ?? null;
    }
    if (!resolved) throw new BadRequestException("No location available for this account");
    return this.upsertPresence(driver, {
      status: DriverPresenceStatus.ONLINE,
      locationId: resolved,
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
            platform: true,
            courierPhone: true,
            courierPhoneAccessCode: true,
            scheduledFor: true,
            estimatedReadyAt: true,
            preparationMinutes: true,
            createdAt: true,
          },
        },
      },
    });

    const ACTIVE: DriverAssignmentStatus[] = [
      DriverAssignmentStatus.ASSIGNED,
      DriverAssignmentStatus.ACCEPTED,
      DriverAssignmentStatus.PICKED_UP,
    ];
    // Attach a computed deadlineAt to every order (drops the raw prep fields the
    // app doesn't need), so the job card can render a minutes-to-deadline pill.
    const withDeadline = assignments.map((a) => {
      const {
        scheduledFor,
        estimatedReadyAt,
        preparationMinutes,
        createdAt,
        ...orderRest
      } = a.order;
      return {
        ...a,
        order: {
          ...orderRest,
          deadlineAt: deadlineFor({
            scheduledFor,
            estimatedReadyAt,
            preparationMinutes,
            createdAt,
          })?.toISOString() ?? null,
        },
      };
    });

    const active = withDeadline.filter((a) => ACTIVE.includes(a.status));
    const history = withDeadline.filter((a) => !ACTIVE.includes(a.status));

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

  /** Cash-up totals (counts + £) split by cash/card for a date range. */
  async cashUpRange(user: AuthenticatedUser, fromISO?: string, toISO?: string) {
    const driver = await this.resolveDriver(user);
    const start = fromISO
      ? new Date(fromISO)
      : (() => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d;
        })();
    const end = toISO ? new Date(toISO) : new Date();

    const delivered = await this.prisma.driverAssignment.findMany({
      where: {
        driverId: driver.id,
        status: DriverAssignmentStatus.DELIVERED,
        deliveredAt: { gte: start, lte: end },
      },
      include: { order: { select: { total: true, paymentMethod: true } } },
    });

    let cashCount = 0;
    let cardCount = 0;
    let cashTotal = 0;
    let cardTotal = 0;
    for (const a of delivered) {
      const t = Number(a.order.total);
      const method = (a.order.paymentMethod ?? "").toUpperCase();
      if (method.includes("CASH")) {
        cashCount += 1;
        cashTotal += t;
      } else {
        cardCount += 1;
        cardTotal += t;
      }
    }

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      deliveries: delivered.length,
      cashCount,
      cardCount,
      cashTotal: cashTotal.toFixed(2),
      cardTotal: cardTotal.toFixed(2),
      total: (cashTotal + cardTotal).toFixed(2),
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
          // Stamp outForDeliveryAt so the customer tracking page lights up the
          // "Out for delivery" step + live map the moment the driver starts.
          data: { status: OrderStatus.OUT_FOR_DELIVERY, outForDeliveryAt: now },
        });
        await this.upsertPresence(driver, {
          status: DriverPresenceStatus.ON_JOB,
          activeAssignmentId: assignment.id,
        });
        break;

      case "arrived": // at the customer's door (between picked-up and delivered)
        await this.prisma.driverAssignment.update({
          where: { id: assignment.id },
          data: { arrivedAt: now },
        });
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.RIDER_ARRIVED },
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
          data: { status: OrderStatus.COMPLETED, deliveredAt: now },
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

    // Propagate the transition to HubRise (fire-and-forget; no-ops for
    // non-HubRise orders) so connected channels see the same lifecycle the
    // driver walks. Mirrors the operator-side OrdersService.updateStatus push.
    const pushStatus = DriverAppService.PUSH_STATUS_BY_ACTION[action];
    if (pushStatus) {
      void this.hubriseSync.pushStatus({ orderId, newStatus: pushStatus });
    }

    return { ok: true, action };
  }
}
