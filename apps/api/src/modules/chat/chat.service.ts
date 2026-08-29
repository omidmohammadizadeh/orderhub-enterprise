import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ExpoPushService } from "../driver-app/expo-push.service";
import { accessibleLocationIds } from "../../common/access/accessible-locations";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export type ChatSender = "OPERATOR" | "DRIVER" | "CUSTOMER";

export interface ChatMessageDto {
  id: string;
  senderType: ChatSender;
  senderName: string | null;
  body: string;
  createdAt: string;
}

interface RawMessage {
  id: string;
  senderType: string;
  senderName: string | null;
  body: string;
  createdAt: Date;
}

function toDto(m: RawMessage): ChatMessageDto {
  return {
    id: m.id,
    senderType: m.senderType as ChatSender,
    senderName: m.senderName,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

// Dispatch chat. Two channels share one table:
//   • DRIVER_OPERATOR — keyed by (tenantId, driverId)
//   • CUSTOMER_DRIVER — keyed by orderId
// Realtime is polling-based; these methods just read/write + track read state.
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPush: ExpoPushService,
  ) {}

  /** Best-effort push to a driver's device for a new chat message. */
  private async pushToDriver(
    driverId: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ) {
    const presence = await this.prisma.driverPresence.findUnique({
      where: { driverId },
      select: { pushToken: true },
    });
    await this.expoPush.sendMessage(presence?.pushToken, {
      title,
      body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      data,
    });
  }

  // ── Operator ↔ Driver ───────────────────────────────────────────────────────
  async driverThread(tenantId: string, driverId: string): Promise<ChatMessageDto[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { tenantId, driverId, channel: "DRIVER_OPERATOR" },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return rows.map(toDto);
  }

  async postDriverOperator(
    tenantId: string,
    driverId: string,
    senderType: "OPERATOR" | "DRIVER",
    body: string,
    senderName?: string | null,
  ): Promise<ChatMessageDto> {
    const row = await this.prisma.chatMessage.create({
      data: { tenantId, driverId, channel: "DRIVER_OPERATOR", senderType, senderName, body },
    });
    // Notify the driver's device when the operator messages them.
    if (senderType === "OPERATOR") {
      await this.pushToDriver(driverId, "Dispatch", body, { channel: "DRIVER_OPERATOR" });
    }
    return toDto(row);
  }

  /** Mark the *incoming* messages of a driver↔operator thread as read by `reader`. */
  async readDriverThread(tenantId: string, driverId: string, reader: "OPERATOR" | "DRIVER") {
    if (reader === "OPERATOR") {
      await this.prisma.chatMessage.updateMany({
        where: { tenantId, driverId, channel: "DRIVER_OPERATOR", senderType: "DRIVER", readByOperatorAt: null },
        data: { readByOperatorAt: new Date() },
      });
    } else {
      await this.prisma.chatMessage.updateMany({
        where: { tenantId, driverId, channel: "DRIVER_OPERATOR", senderType: "OPERATOR", readByDriverAt: null },
        data: { readByDriverAt: new Date() },
      });
    }
  }

  /**
   * The drivers this operator is allowed to talk to.
   *
   * A driver has a home location (Driver.locationId). Scoped to one shop we
   * list that shop's drivers; with no shop picked we list every driver across
   * the locations the caller can actually reach. Unassigned drivers (null
   * home) appear only in the unscoped view, which is the documented Phase BG
   * behaviour — there is no shop to file them under.
   *
   * `locationId` comes from a dropdown in the browser, so it may only ever
   * NARROW: a location the caller has no assignment for yields nothing rather
   * than reaching past their own set.
   */
  private async driverScopeWhere(
    user: Pick<AuthenticatedUser, "userId" | "tenantId" | "role">,
    locationId?: string,
  ): Promise<Record<string, unknown> | null> {
    const allowed = await accessibleLocationIds(this.prisma, user);
    if (locationId) {
      if (!allowed.includes(locationId)) return null;
      return { locationId };
    }
    if (allowed.length === 0) return null;
    return { OR: [{ locationId: { in: allowed } }, { locationId: null }] };
  }

  /** Whether this operator may read or write one driver's thread. */
  async assertDriverInScope(
    user: Pick<AuthenticatedUser, "userId" | "tenantId" | "role">,
    driverId: string,
  ): Promise<void> {
    const scope = await this.driverScopeWhere(user);
    const driver = scope
      ? await this.prisma.driver.findFirst({
          where: { id: driverId, tenantId: user.tenantId, ...scope },
          select: { id: true },
        })
      : null;
    // Not found and not permitted are the same answer on purpose — probing
    // ids should not reveal which drivers exist at other shops.
    if (!driver) throw new NotFoundException("Driver not found");
  }

  /** Operator inbox: every driver IN SCOPE with their last message + unread count. */
  async operatorThreads(
    user: Pick<AuthenticatedUser, "userId" | "tenantId" | "role">,
    locationId?: string,
  ) {
    const tenantId = user.tenantId;
    const scope = await this.driverScopeWhere(user, locationId);
    if (!scope) return [];
    const drivers = await this.prisma.driver.findMany({
      where: { tenantId, isActive: true, ...scope },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        presence: { select: { status: true } },
      },
      orderBy: { firstName: "asc" },
    });

    const threads = await Promise.all(
      drivers.map(async (d) => {
        const [last, unread] = await Promise.all([
          this.prisma.chatMessage.findFirst({
            where: { tenantId, driverId: d.id, channel: "DRIVER_OPERATOR" },
            orderBy: { createdAt: "desc" },
          }),
          this.prisma.chatMessage.count({
            where: {
              tenantId,
              driverId: d.id,
              channel: "DRIVER_OPERATOR",
              senderType: "DRIVER",
              readByOperatorAt: null,
            },
          }),
        ]);
        return {
          driverId: d.id,
          name: `${d.firstName} ${d.lastName}`.trim(),
          status: d.presence?.status ?? "OFFLINE",
          lastBody: last?.body ?? null,
          lastAt: last?.createdAt ? last.createdAt.toISOString() : null,
          unread,
        };
      }),
    );

    // Unread first, then most-recently active.
    threads.sort((a, b) => b.unread - a.unread || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
    return threads;
  }

  /** Driver's unread count from the operator (for the app's menu badge). */
  async driverUnread(tenantId: string, driverId: string): Promise<number> {
    return this.prisma.chatMessage.count({
      where: { tenantId, driverId, channel: "DRIVER_OPERATOR", senderType: "OPERATOR", readByDriverAt: null },
    });
  }

  // ── Customer ↔ Driver (order-scoped) ─────────────────────────────────────────
  async customerThread(orderId: string): Promise<ChatMessageDto[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { orderId, channel: "CUSTOMER_DRIVER" },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return rows.map(toDto);
  }

  async postCustomerDriver(
    orderId: string,
    senderType: "CUSTOMER" | "DRIVER",
    body: string,
    senderName?: string | null,
  ): Promise<ChatMessageDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        tenantId: true,
        displayId: true,
        orderNumber: true,
        driverAssignment: { select: { driverId: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const driverId = order.driverAssignment?.driverId ?? null;
    const row = await this.prisma.chatMessage.create({
      data: {
        tenantId: order.tenantId,
        orderId,
        driverId,
        channel: "CUSTOMER_DRIVER",
        senderType,
        senderName,
        body,
      },
    });
    // Notify the driver's device when the customer messages them.
    if (senderType === "CUSTOMER" && driverId) {
      const ref = `#${order.displayId ?? order.orderNumber ?? order.id.slice(-5)}`;
      await this.pushToDriver(driverId, `Customer · ${ref}`, body, {
        channel: "CUSTOMER_DRIVER",
        orderId: order.id,
      });
    }
    return toDto(row);
  }

  async readCustomerThread(orderId: string, reader: "CUSTOMER" | "DRIVER") {
    if (reader === "CUSTOMER") {
      await this.prisma.chatMessage.updateMany({
        where: { orderId, channel: "CUSTOMER_DRIVER", senderType: "DRIVER", readByCustomerAt: null },
        data: { readByCustomerAt: new Date() },
      });
    } else {
      await this.prisma.chatMessage.updateMany({
        where: { orderId, channel: "CUSTOMER_DRIVER", senderType: "CUSTOMER", readByDriverAt: null },
        data: { readByDriverAt: new Date() },
      });
    }
  }
}
