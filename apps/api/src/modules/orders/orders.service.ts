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
import { PrintQueueService } from "../printers/print-queue.service";
import { PrintJobsService } from "../printers/print-jobs.service";
import { PaymentsService } from "../payments/payments.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import { assertTransition, getTimestampField } from "./order-state-machine";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import type { CanonicalOrder } from "@orderhub/shared";

// Phase AM — if the operator scheduled this order more than this many seconds
// into the future, we suppress the immediate PrinterJob and surface a
// "Start preparing now" action on the Orders board instead.
const SCHEDULED_FUTURE_THRESHOLD_SECONDS = 60 * 10; // 10 min

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
    private readonly printQueue: PrintQueueService, // Phase AM
    private readonly printJobs: PrintJobsService, // Phase AS-2
    private readonly promoCodes: PromoCodesService, // Phase AM
    private readonly payments: PaymentsService, // Phase AP-8 — Stripe manual-capture lifecycle hooks
  ) {}

  /**
   * Phase AM — claim the next sequential order number for a tenant.
   * Uses upsert + atomic increment so concurrent POS submits never
   * collide. The first call for a tenant seeds nextValue=1, returns 1,
   * and bumps nextValue to 2.
   */
  private async allocateOrderNumber(tenantId: string): Promise<number> {
    // Upsert ensures the row exists, then update with increment claims
    // the value. Two-step rather than a single upsert with increment
    // because Prisma doesn't allow combining increment with create.
    await this.prisma.orderNumberSequence.upsert({
      where: { tenantId },
      create: { tenantId, nextValue: 1 },
      update: {},
    });
    const seq = await this.prisma.orderNumberSequence.update({
      where: { tenantId },
      data: { nextValue: { increment: 1 } },
    });
    // We just incremented to N+1; the value we want is N (the pre-increment one).
    return seq.nextValue - 1;
  }

  /**
   * True if the order should NOT trigger an immediate print at creation time.
   * The cut-off is 10 minutes — anything inside that window is treated as
   * "for now" because the kitchen lead time absorbs it.
   */
  private isFutureScheduled(scheduledFor?: Date | null): boolean {
    if (!scheduledFor) return false;
    const secondsAhead = (scheduledFor.getTime() - Date.now()) / 1000;
    return secondsAhead > SCHEDULED_FUTURE_THRESHOLD_SECONDS;
  }

  /**
   * Phase AS-5 — flip a freshly-ingested order from PENDING → ACCEPTED
   * when the location has `settings.autoAcceptOrders` set. Runs in the
   * background so a slow accept never blocks the ingest path. Failures
   * are logged and swallowed; the operator can still tap Accept manually.
   */
  private async maybeAutoAccept(
    orderId: string,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    try {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { settings: true },
      });
      const settings = (location?.settings ?? {}) as Record<string, unknown>;
      if (settings.autoAcceptOrders !== true) return;
      await this.updateStatus(
        orderId,
        tenantId,
        { status: "ACCEPTED" } as UpdateOrderStatusDto,
        "system:auto-accept",
        "SYSTEM" as OrderStatusActorType,
      );
    } catch (err: any) {
      this.logger.warn(
        `Auto-accept failed for order ${orderId}: ${err?.message ?? err}`,
      );
    }
  }

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
            // Phase AP-5 — link signed-in storefront customers to their
            // CustomerAccount so the "My Orders" page can list this
            // order. Undefined for non-storefront sources (POS, platform
            // webhooks) and for guest checkouts.
            customerAccountId: (canonical as any).customerAccountId ?? undefined,
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

      // Phase AP-8 — suppress the realtime "new order" broadcast for
      // unpaid CARD orders. We persist the row early so Stripe Checkout
      // can attach to a real orderId, but the restaurant must NOT see it
      // until payment_intent.amount_capturable_updated lands and we flip
      // paymentStatus to AUTHORIZED. The live-board DB query already
      // filters these out; the socket is the side channel we have to
      // gate manually. markAuthorized() emits the new-order event when
      // the customer actually pays.
      const meta: any = (canonical as any).metadata ?? {};
      const isUnpaidCard =
        meta.paymentMethod === "CARD" && meta.paymentStatus === "PENDING";

      // Socket emit is best-effort and immediate — it does NOT affect downstream
      // processing which is guaranteed by the outbox.
      // Phase AS-5 — location-level auto-accept. If the operator has
      // ticked the toggle on the Printers → Automation tab, every
      // incoming order skips PENDING and goes straight to ACCEPTED, which
      // triggers the existing print pipeline + accepted-event socket.
      // Skipped for:
      //   - scheduled orders (operator decides when to start prep)
      //   - unpaid CARD orders (must wait for Stripe authorization)
      // Errors are swallowed deliberately — auto-accept is a convenience,
      // never a hard requirement for ingest to succeed.
      const isScheduledFuture = this.isFutureScheduled(canonical.scheduledFor);
      if (!isUnpaidCard && !isScheduledFuture) {
        void this.maybeAutoAccept(order.id, tenantId, locationId);
      }

      if (!isUnpaidCard) this.socket.emitNewOrder(locationId, {
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

    const scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : undefined;
    const isScheduled = dto.isScheduled === true || this.isFutureScheduled(scheduledFor);

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
      scheduledFor,
      idempotencyKey: dto.idempotencyKey,
      metadata: {
        callerId: dto.callerId,
        discountType: dto.discountType,
        promoCode: dto.promoCode,
        paymentMethod: dto.paymentMethod,
        paymentProvider: dto.paymentProvider,
        paymentStatus: dto.paymentStatus,
        preparationMinutes: dto.preparationMinutes,
        isScheduled,
      },
      // Phase AP-5 — thread the storefront customerAccountId through
      // to persistOrder so the Order row gets attributed and the
      // customer's "My Orders" page can find it. CanonicalOrder
      // doesn't have a typed slot for this yet (marketplace adapters
      // don't need it) so we ride along on the (canonical as any)
      // cast at the persist site. Undefined for guest checkouts.
      customerAccountId: (dto as any).customerAccountId,
    };

    const order = await this.ingestCanonical(canonical as any, tenantId, dto.locationId);

    // Persist the POS-specific structured columns + payment fields. We do
    // this in a follow-up update rather than threading every field through
    // CanonicalOrder so the webhook adapters stay unchanged.
    const posUpdate: Prisma.OrderUpdateInput = {};
    if (dto.deliveryAddress) {
      posUpdate.addressLine1 = dto.deliveryAddress.line1;
      posUpdate.addressLine2 = dto.deliveryAddress.line2 ?? null;
      posUpdate.city = dto.deliveryAddress.city;
      posUpdate.postcode = dto.deliveryAddress.postcode;
    }
    if (dto.customerInfo?.name) posUpdate.customerName = dto.customerInfo.name;
    if (dto.customerInfo?.phone) posUpdate.customerPhone = dto.customerInfo.phone;
    if (dto.callerId !== undefined) posUpdate.callerId = dto.callerId;
    if (dto.preparationMinutes !== undefined) {
      posUpdate.preparationMinutes = dto.preparationMinutes;
      if (dto.preparationMinutes > 0 && !isScheduled) {
        posUpdate.estimatedReadyAt = new Date(
          Date.now() + dto.preparationMinutes * 60_000,
        );
      }
    }
    if (scheduledFor) posUpdate.scheduledAt = scheduledFor;
    if (dto.discountType !== undefined) posUpdate.discountType = dto.discountType;
    if (dto.promoCode !== undefined) posUpdate.promoCode = dto.promoCode;
    if (dto.discount !== undefined && dto.discount > 0) {
      posUpdate.promoDiscount = dto.discount;
    }
    if (dto.paymentMethod !== undefined) posUpdate.paymentMethod = dto.paymentMethod;
    if (dto.paymentProvider !== undefined) {
      posUpdate.paymentProvider = dto.paymentProvider;
    }
    if (dto.paymentStatus !== undefined) {
      posUpdate.paymentStatus = dto.paymentStatus as any;
    }

    // Phase AM (+ AP fix) — allocate sequential per-tenant order number
    // for orders we own ourselves: POS, DIRECT, and ONLINE storefront.
    // Marketplace orders (Just Eat / Uber Eats / Deliveroo / HubRise)
    // arrive with their own platform-issued displayId so they keep
    // that and skip the counter — the operator wants the marketplace's
    // number on the card so the customer service ticket lookups still
    // work both ways.
    const isInternal =
      (canonical.orderSource as string) === "POS" ||
      (canonical.orderSource as string) === "DIRECT" ||
      (canonical.orderSource as string) === "ONLINE";
    if (isInternal) {
      const orderNumber = await this.allocateOrderNumber(tenantId);
      posUpdate.orderNumber = orderNumber;
    }

    if (Object.keys(posUpdate).length > 0) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: posUpdate,
      });
    }

    // Promo code: bump usage AFTER persistence so we don't burn a use on a
    // failed write.
    if (dto.promoCode) {
      void this.promoCodes.incrementUsage(tenantId, dto.promoCode);
    }

    return order;
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

    // Phase AM — wire the print pipeline. Triggers on:
    //   • PENDING → ACCEPTED (the POS auto-accept path and the manager-tap
    //     accept path both go through here).
    //   • Scheduled future orders bypass the trigger at create-time and arrive
    //     here when the operator clicks "Start preparing now".
    // CANCELLED also fires a cancel ticket so the kitchen knows to bin the bag.
    // Phase AS-2 — drive the print engine off the same status events.
    // Each non-MANUAL trigger fans out via PrintJobsService which honours
    // each printer's autoPrintRules; printers without a matching rule
    // silently skip. Scheduled orders short-circuit ORDER_RECEIVED in
    // the service.
    const triggerForStatus = (() => {
      switch (newStatus) {
        case "ACCEPTED": return "ORDER_ACCEPTED";
        case "PREPARING": return "ORDER_PREPARING";
        case "READY": return "ORDER_READY";
        default: return null;
      }
    })();
    if (triggerForStatus) {
      this.printJobs
        .createFromOrder({ orderId, trigger: triggerForStatus as any })
        .catch((err: any) =>
          this.logger.warn(
            `createFromOrder(${triggerForStatus}) failed for ${orderId}: ${err.message}`,
          ),
        );
    }

    if (newStatus === "ACCEPTED") {
      // Legacy POS print pipeline — kept until the Bull-queue path is
      // fully drained. Best-effort, never rolls back the status change.
      this.printQueue.enqueueForNewOrder(orderId).catch((err: any) => {
        this.logger.warn(
          `enqueueForNewOrder failed for ${orderId}: ${err.message}`,
        );
      });
      // Phase AP-8 — capture the held card authorization. No-op for
      // cash orders / orders without a held PI. Best-effort by design;
      // a capture failure is reported in logs and surfaced to ops, but
      // does NOT roll back the status change because the bag is going
      // out either way and reconciliation can happen out-of-band.
      this.payments
        .captureForOrder(orderId)
        .catch((err: any) =>
          this.logger.error(`Stripe capture failed for ${orderId}: ${err.message}`),
        );
    } else if (newStatus === "CANCELLED" || newStatus === "REJECTED") {
      this.printQueue.enqueueCancel(orderId).catch((err: any) => {
        this.logger.warn(
          `enqueueCancel failed for ${orderId}: ${err.message}`,
        );
      });
      // Phase AP-8 — refund-or-cancel based on capture state.
      // refundForOrder() is the smart entry point: if the payment is
      // already captured it issues a refund; if it's still in
      // authorization (pre-accept rejection) it cancels the auth
      // instead, which is cheaper and leaves no charge on the
      // customer's statement.
      this.payments
        .refundForOrder(orderId, dto.cancelReason ?? undefined)
        .catch((err: any) =>
          this.logger.error(`Stripe refund/cancel failed for ${orderId}: ${err.message}`),
        );
    }

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

  /**
   * Phase AM — list orders that the POS marked as "scheduled for later".
   * These are still PENDING (no printer fired, kitchen doesn't see them yet)
   * with a non-null scheduledAt in the future. Used by the Orders board to
   * render a dedicated Scheduled section.
   */
  async findScheduledOrders(tenantId: string, locationId?: string) {
    return this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        status: { in: ["PENDING"] },
        scheduledAt: { not: null, gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      include: ORDER_INCLUDE,
      orderBy: { scheduledAt: "asc" },
    });
  }

  /**
   * Phase AM — "Start preparing now" action for scheduled orders.
   * Transitions PENDING → ACCEPTED via the normal status path so the print
   * pipeline (and status history, outbox, websocket emit) fire identically
   * to a regular accept. Also nulls scheduledAt so the order leaves the
   * Scheduled section on the board.
   */
  async startPreparingScheduled(
    orderId: string,
    tenantId: string,
    changedBy: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "PENDING") {
      throw new ConflictException(
        `Order is in status ${order.status} — cannot start preparing`,
      );
    }

    // Clear scheduledAt so the order disappears from the Scheduled board.
    // We KEEP scheduledFor for audit (so we can compare promised vs actual).
    await this.prisma.order.update({
      where: { id: orderId },
      data: { scheduledAt: null },
    });

    return this.updateStatus(
      orderId,
      tenantId,
      { status: "ACCEPTED", note: "Started early via POS" },
      changedBy,
      "STAFF",
    );
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
        // Phase AP-8 — card orders aren't real to the kitchen until the
        // customer's authorization webhook lands and we flip paymentStatus
        // to AUTHORIZED. Hide PENDING+CARD from the board so staff don't
        // start preparing food the customer hasn't successfully paid for.
        NOT: {
          paymentMethod: "CARD",
          paymentStatus: "PENDING",
        },
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
            // Phase AM — scheduled-for-later orders live in their own
            // section of the Orders board; exclude them here so they don't
            // clutter the "happening now" columns.
            OR: [
              { scheduledAt: null },
              { scheduledAt: { lt: new Date() } },
            ],
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
