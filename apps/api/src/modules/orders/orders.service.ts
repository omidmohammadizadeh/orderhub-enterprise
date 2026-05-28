import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Prisma, Order, OrderStatus, OrderStatusActorType } from "@orderhub/database";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { AuditLogService } from "../auth/services/audit-log.service";
import { OutboxService } from "../outbox/outbox.service";
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
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
  ) {}

  // ── Ingest from adapter (webhook / public ordering) ───

  async ingestCanonical(
    canonical: CanonicalOrder,
    tenantId: string,
    locationId: string,
    options: { isSandbox?: boolean } = {},
  ): Promise<Order> {
    // Order creation and outbox event insertion are atomic. If the process dies
    // between DB commit and queue enqueue, the OutboxDispatcherCron picks up the
    // pending outbox event on its next tick and enqueues the job safely.
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
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
            isSandbox: options.isSandbox ?? false,
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
                actorType: (canonical.integrationSource !== "DIRECT"
                  ? "WEBHOOK"
                  : "SYSTEM") as OrderStatusActorType,
                changedBy:
                  canonical.integrationSource !== "DIRECT"
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

        // Outbox event is written in the same transaction — either both commit or neither does.
        await tx.outboxEvent.create({
          data: this.outbox.forOrderReceived(
            tenantId,
            locationId,
            created.id,
            canonical.platform,
            canonical.externalId ?? created.id,
          ),
        });

        return created;
      });

      this.logger.log(
        `Order ingested: ${order.id} (${canonical.platform}/${canonical.externalId})`,
      );

      void this.audit.log({
        tenantId,
        event: "order.received",
        resource: "order",
        resourceId: order.id,
        meta: {
          platform: canonical.platform,
          externalId: canonical.externalId,
          locationId,
          total: canonical.total,
        },
      });

      // Socket emit is best-effort and immediate — it does NOT affect downstream
      // processing which is guaranteed by the outbox.
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
      // P2002 = unique constraint violation — concurrent ingest already created this order.
      // The matching outbox event was also not created (transaction rolled back), which is correct.
      if (err?.code === "P2002") {
        this.logger.warn(
          `Concurrent ingest detected for ${canonical.platform}/${canonical.externalId} — returning existing order`,
        );
        const existing = await this.prisma.order.findFirst({
          where: canonical.externalId
            ? {
                externalId: canonical.externalId,
                platform: canonical.platform,
              }
            : {
                idempotencyKey: canonical.idempotencyKey,
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

    return this.ingestCanonical(canonical as any, tenantId, dto.locationId);
  }

  // ── Manual test order (Phase AJ) ──────────────────────
  // Creates a single sample order at the given location with isSandbox=true,
  // routed through the full canonical ingest pipeline. Unlike the bulk
  // sandbox.generateOrders helper this is intentionally available in
  // production — operators use it to verify printer/board wiring without
  // having to ask a delivery platform to send a real test order.
  //
  // The order goes in at status=PENDING. Moving it to ACCEPTED via the
  // normal status endpoint triggers the standard print-job pipeline.
  async createTest(
    tenantId: string,
    locationId: string,
    userId: string,
    overrides: { customerName?: string; fulfillmentType?: "PICKUP" | "DELIVERY" } = {},
  ): Promise<Order> {
    // Verify the user can touch this location.
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true, name: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    // Deterministic-but-unique external id so the @@unique([externalId, platform])
    // constraint prevents accidental double-clicks from producing dupes.
    const externalId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerName = overrides.customerName ?? "Test Order";
    const fulfillmentType = overrides.fulfillmentType ?? "DELIVERY";

    const items = [
      { name: "Sample Burger", quantity: 1, unitPrice: 9.5, totalPrice: 9.5, modifiers: [] },
      { name: "Fries", quantity: 1, unitPrice: 3.5, totalPrice: 3.5, modifiers: [] },
      { name: "Soft Drink", quantity: 1, unitPrice: 2.0, totalPrice: 2.0, modifiers: [] },
    ];
    const subtotal = items.reduce((sum, i) => sum + i.totalPrice, 0);
    const taxAmount = 0;
    const deliveryFee = fulfillmentType === "DELIVERY" ? 2.5 : 0;
    const total = subtotal + taxAmount + deliveryFee;

    const canonical = {
      externalId,
      platform: "DIRECT" as const,
      orderSource: "POS" as const,
      integrationSource: "DIRECT" as const,
      viaHubrise: false,
      fulfillmentType,
      displayId: `TEST-${externalId.slice(-4).toUpperCase()}`,
      customerInfo: { name: customerName, phone: "+440000000000" },
      deliveryAddress:
        fulfillmentType === "DELIVERY"
          ? {
              line1: "1 Test Street",
              city: "Sandbox",
              postcode: "TE5 7ER",
              country: "GB",
            }
          : undefined,
      items,
      subtotal,
      taxAmount,
      deliveryFee,
      discount: 0,
      total,
      specialInstructions: "Phase AJ manual test order — safe to discard",
      metadata: { isTestOrder: true, createdByUserId: userId },
    };

    const order = await this.ingestCanonical(
      canonical as any,
      tenantId,
      locationId,
      { isSandbox: true },
    );

    void this.audit.log({
      tenantId,
      userId,
      event: "order.test.created",
      resource: "order",
      resourceId: order.id,
      meta: { locationId, externalId, fulfillmentType },
    });

    return order;
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

      // Outbox event is written in the same transaction as the status update.
      await tx.outboxEvent.create({
        data: this.outbox.forStatusChanged(
          tenantId,
          order.locationId,
          orderId,
          order.status,
          newStatus,
          dto.cancelReason,
        ),
      });

      return updated;
    });

    void this.audit.log({
      tenantId,
      userId: changedBy,
      event: `order.status.${newStatus.toLowerCase()}`,
      resource: "order",
      resourceId: orderId,
      before: { status: order.status },
      after: { status: newStatus },
      meta: {
        locationId: order.locationId,
        platform: order.platform,
        actorType,
        cancelReason: dto.cancelReason,
      },
    });

    // Broadcast update — best-effort, immediate
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
        itemCount: 0,
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
    // The board shows every active order PLUS terminal orders from the last
    // 24 hours so operators can see what just completed / was cancelled
    // without leaving the page. After 24h terminal orders drop off the live
    // board and live only in /v1/orders (history) — that keeps the live
    // query bounded as volume grows.
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        OR: [
          {
            status: {
              in: [
                "PENDING",
                "ACCEPTED",
                "PREPARING",
                "READY",
                "PENDING_DISPATCH",
                "ASSIGNED_DRIVER",
                "ACCEPTED_BY_DRIVER",
                "OUT_FOR_DELIVERY",
                "DISPATCHED",
              ],
            },
          },
          {
            status: { in: ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"] },
            updatedAt: { gte: since24h },
          },
        ],
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }
}
