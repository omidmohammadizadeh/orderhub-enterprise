import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import type { Prisma, Order, OrderStatus, OrderStatusActorType } from "@orderhub/database";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { assertTransition, getTimestampField } from "./order-state-machine";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import type { CanonicalOrder } from "@orderhub/shared";

const ORDER_INCLUDE = {
  items: true,
  statusHistory: { orderBy: { createdAt: "asc" as const } },
  location: { select: { id: true, name: true, brandId: true } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export interface OrderFilters {
  locationId?: string;
  status?: OrderStatus | OrderStatus[];
  platform?: string;
  orderSource?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
    @InjectQueue(QUEUES.PRINTING) private readonly printQueue: Queue,
  ) {}

  // ── Ingest from adapter (webhook / public ordering) ───

  async ingestCanonical(
    canonical: CanonicalOrder,
    tenantId: string,
    locationId: string,
  ): Promise<Order> {
    // Attempt creation first — the DB unique constraints on (externalId, platform)
    // and idempotencyKey are the authoritative deduplication mechanism.
    // A pre-check + create is a TOCTOU race: two concurrent webhook deliveries for
    // the same order would both pass the check and one would violate the unique
    // constraint. We handle the P2002 here and return the existing row instead.
    try {
    const order = await this.prisma.order.create({
      data: {
        tenantId,
        locationId,
        externalId: canonical.externalId,
        platform: canonical.platform,
        displayId: canonical.displayId,
        orderSource: canonical.orderSource,
        integrationSource: canonical.integrationSource,
        viaHubrise: canonical.viaHubrise,
        fulfillmentType: canonical.fulfillmentType,
        status: "PENDING",
        customerName: canonical.customerInfo.name ?? null,
        customerPhone: canonical.customerInfo.phone ?? null,
        customerInfo: canonical.customerInfo as Prisma.InputJsonValue,
        deliveryAddress: canonical.deliveryAddress
          ? (canonical.deliveryAddress as Prisma.InputJsonValue)
          : undefined,
        subtotal: canonical.subtotal,
        taxAmount: canonical.taxAmount,
        deliveryFee: canonical.deliveryFee,
        discount: canonical.discount,
        total: canonical.total,
        specialInstructions: canonical.specialInstructions,
        scheduledFor: canonical.scheduledFor,
        idempotencyKey: canonical.idempotencyKey,
        metadata: canonical.metadata as Prisma.InputJsonValue,
        statusHistory: {
          create: {
            tenantId,
            toStatus: "PENDING",
            actorType: (canonical.integrationSource !== "DIRECT" ? "WEBHOOK" : "SYSTEM") as OrderStatusActorType,
            changedBy: canonical.integrationSource !== "DIRECT"
              ? `webhook:${canonical.integrationSource}`
              : "system",
          },
        },
        items: {
          create: canonical.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            modifiers: item.modifiers as Prisma.InputJsonValue,
            notes: item.notes,
          })),
        },
      },
    });

    this.logger.log(
      `Order ingested: ${order.id} (${canonical.platform}/${canonical.externalId})`,
    );

    // Enqueue downstream processing (KDS + print + notifications)
    await this.orderQueue.add(
      ORDER_JOBS.INGEST,
      { orderId: order.id, tenantId, locationId },
      { jobId: `ingest-${order.id}` }, // deterministic — safe to re-add on retry
    );

    // Broadcast new order to connected dashboards
    this.socket.emitNewOrder(locationId, {
      orderId: order.id,
      tenantId,
      locationId,
      platform: order.platform,
      orderSource: order.orderSource,
      fulfillmentType: order.fulfillmentType,
      displayId: order.displayId,
      status: order.status,
      total: Number(order.total),
      itemCount: canonical.items.reduce((sum, i) => sum + i.quantity, 0),
      customerName: canonical.customerInfo.name,
      scheduledFor: order.scheduledFor?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    });

    return order;
    } catch (err: any) {
      // P2002 = unique constraint violation — a concurrent ingest already created this order.
      // Return the existing record so the webhook handler can respond 200 without reprocessing.
      if (err?.code === "P2002") {
        this.logger.warn(
          `Concurrent ingest detected for ${canonical.platform}/${canonical.externalId} — returning existing order`,
        );
        const existing = await this.prisma.order.findUnique({
          where: {
            externalId_platform: {
              externalId: canonical.externalId,
              platform: canonical.platform,
            },
          },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ── Direct order creation (POS / staff) ──────────────

  async create(dto: CreateOrderDto, tenantId: string): Promise<Order> {
    const location = await this.prisma.location.findFirst({
      where: { id: dto.locationId, brand: { tenantId } },
    });
    if (!location) throw new NotFoundException("Location not found");

    const canonical = {
      externalId: `direct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platform: "DIRECT" as const,
      orderSource: dto.orderSource ?? ("DIRECT" as const),
      integrationSource: "DIRECT" as const,
      viaHubrise: false,
      fulfillmentType: dto.fulfillmentType ?? ("DELIVERY" as const),
      displayId: undefined,
      customerInfo: dto.customerInfo,
      deliveryAddress: dto.deliveryAddress
        ? { ...dto.deliveryAddress, country: dto.deliveryAddress.country ?? "GB" }
        : undefined,
      items: dto.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.totalPrice,
        notes: i.notes,
        sku: i.sku,
        modifiers: (i.modifiers ?? []).map((m) => ({
          name: m.name,
          price: m.price,
          quantity: m.quantity ?? 1,
        })),
      })),
      subtotal: dto.subtotal,
      taxAmount: dto.taxAmount ?? 0,
      deliveryFee: dto.deliveryFee ?? 0,
      discount: dto.discount ?? 0,
      total: dto.total,
      specialInstructions: dto.specialInstructions,
      scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : undefined,
      idempotencyKey: dto.idempotencyKey,
      metadata: {},
    };

    return this.ingestCanonical(canonical, tenantId, dto.locationId);
  }

  // ── Status transitions ────────────────────────────────

  async updateStatus(
    orderId: string,
    tenantId: string,
    dto: UpdateOrderStatusDto,
    changedBy: string,
    actorType: OrderStatusActorType = "STAFF",
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    const newStatus = dto.status as OrderStatus;
    assertTransition(order.status, newStatus);

    const timestampField = getTimestampField(newStatus);
    const timestampData = timestampField ? { [timestampField]: new Date() } : {};

    const updated = await this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency: include updatedAt in where clause.
      // If another request updated the order between our read and this write,
      // the update will match 0 rows and we throw a 409 Conflict.
      const result = await tx.order.updateMany({
        where: { id: orderId, updatedAt: order.updatedAt },
        data: {
          status: newStatus,
          cancelReason: dto.cancelReason,
          ...timestampData,
        },
      });

      if (result.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Fetch the latest state and retry.",
        );
      }

      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          tenantId,
          fromStatus: order.status,
          toStatus: newStatus,
          actorType,
          changedBy,
          note: dto.note,
        },
      });

      return updated;
    });

    // Enqueue status-change jobs (print, notifications, platform sync)
    await this.orderQueue.add(ORDER_JOBS.STATUS_CHANGE, {
      orderId,
      tenantId,
      locationId: order.locationId,
      fromStatus: order.status,
      toStatus: newStatus,
      cancelReason: dto.cancelReason,
    });

    // Broadcast update
    if (newStatus === "CANCELLED") {
      this.socket.emitToLocation(order.locationId, "order:cancelled", {
        orderId,
        locationId: order.locationId,
        reason: dto.cancelReason ?? null,
        cancelledAt: updated.cancelledAt?.toISOString() ?? new Date().toISOString(),
      });
    } else {
      this.socket.emitOrderUpdated(order.locationId, {
        orderId,
        tenantId,
        locationId: order.locationId,
        platform: updated.platform,
        orderSource: updated.orderSource,
        fulfillmentType: updated.fulfillmentType,
        displayId: updated.displayId,
        status: updated.status,
        total: Number(updated.total),
        itemCount: 0, // not needed for updates
        customerName: (updated.customerInfo as any)?.name ?? "",
        scheduledFor: updated.scheduledFor?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
      });
    }

    return updated;
  }

  // ── Queries ───────────────────────────────────────────

  async findMany(tenantId: string, filters: OrderFilters) {
    const {
      locationId,
      status,
      platform,
      orderSource,
      from,
      to,
      page = 1,
      limit = 50,
    } = filters;

    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
      ...(status && {
        status: Array.isArray(status) ? { in: status } : status,
      }),
      ...(platform && { platform: platform as any }),
      ...(orderSource && { orderSource: orderSource as any }),
      ...(from || to
        ? {
            createdAt: {
              ...(from && { gte: from }),
              ...(to && { lte: to }),
            },
          }
        : {}),
    };

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, page, limit, orders };
  }

  async findOne(orderId: string, tenantId: string): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async findLiveOrders(tenantId: string, locationId?: string) {
    return this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        status: { in: ["PENDING", "ACCEPTED", "PREPARING", "READY", "DISPATCHED"] },
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  }
}
