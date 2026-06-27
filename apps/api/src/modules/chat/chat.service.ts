import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

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

  /** Operator inbox: every active driver with their last message + unread count. */
  async operatorThreads(tenantId: string) {
    const drivers = await this.prisma.driver.findMany({
      where: { tenantId, isActive: true },
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
      select: { id: true, tenantId: true, driverAssignment: { select: { driverId: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");
    const row = await this.prisma.chatMessage.create({
      data: {
        tenantId: order.tenantId,
        orderId,
        driverId: order.driverAssignment?.driverId ?? null,
        channel: "CUSTOMER_DRIVER",
        senderType,
        senderName,
        body,
      },
    });
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
