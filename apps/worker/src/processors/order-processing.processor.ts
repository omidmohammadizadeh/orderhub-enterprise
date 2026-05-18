import { Processor, Process, OnQueueFailed, OnQueueCompleted } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Job, Queue } from "bull";
import type { PrintJobType, OrderStatus } from "@orderhub/database";
import { QUEUES, ORDER_JOBS, PRINT_JOBS } from "@orderhub/shared";
import { PrismaService } from "../infrastructure/prisma.service";
import { EventPublisherService } from "../infrastructure/event-publisher.service";

interface IngestJobData {
  orderId: string;
  tenantId: string;
  locationId: string;
}

interface StatusChangeJobData {
  orderId: string;
  tenantId: string;
  locationId: string;
  fromStatus: string;
  toStatus: string;
  cancelReason?: string;
}

@Processor(QUEUES.ORDER_PROCESSING)
export class OrderProcessingProcessor {
  private readonly logger = new Logger(OrderProcessingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisherService,
    @InjectQueue(QUEUES.PRINTING) private readonly printQueue: Queue,
    @InjectQueue(QUEUES.ORDER_SYNC) private readonly syncQueue: Queue,
  ) {}

  // ── INGEST: new order arrived ──────────────────────────
  @Process(ORDER_JOBS.INGEST)
  async handleIngest(job: Job<IngestJobData>) {
    const { orderId, tenantId, locationId } = job.data;
    this.logger.log(`[${orderId}] Processing new order`);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      this.logger.warn(`[${orderId}] Order not found — skipping`);
      return;
    }

    // ── 1. Create print jobs ───────────────────────────────
    await this.createPrintJobsForNewOrder(order);

    // ── 2. Create KDS tickets ─────────────────────────────
    await this.createKdsTickets(orderId, locationId);

    // ── 3. Emit socket event (already emitted from API on create,
    //       but if missed, re-emit from worker as fallback) ─
    this.logger.log(`[${orderId}] Ingest pipeline complete`);
  }

  // ── STATUS_CHANGE ──────────────────────────────────────
  @Process(ORDER_JOBS.STATUS_CHANGE)
  async handleStatusChange(job: Job<StatusChangeJobData>) {
    const { orderId, tenantId, locationId, fromStatus, toStatus, cancelReason } = job.data;
    this.logger.log(`[${orderId}] Status change: ${fromStatus} → ${toStatus}`);

    // ── 1. Enqueue outbound platform sync ─────────────────
    // Deterministic jobId prevents duplicate sync jobs on Redis restart or
    // double-delivery of the STATUS_CHANGE queue message.
    await this.syncQueue.add(
      ORDER_JOBS.SYNC_STATUS,
      { orderId, tenantId, locationId, toStatus, cancelReason },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
        jobId: `sync-${orderId}-${toStatus}`,
      },
    );

    // ── 2. Print jobs triggered by status transitions ─────
    if (toStatus === "ACCEPTED") {
      await this.triggerAcceptedPrints(orderId, tenantId, locationId);
    }
    if (toStatus === "CANCELLED") {
      await this.triggerCancelTicket(orderId, tenantId, locationId, cancelReason);
    }

    // ── 3. Bump KDS if READY ──────────────────────────────
    if (toStatus === "COMPLETED" || toStatus === "READY") {
      await this.bumpKdsTickets(orderId);
    }

    this.logger.log(`[${orderId}] Status change pipeline complete (${toStatus})`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `Job ${job.name}#${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`,
      err.stack,
    );
  }

  // ── Private helpers ────────────────────────────────────

  private async createPrintJobsForNewOrder(order: any) {
    const printers = await this.prisma.printer.findMany({
      where: { locationId: order.locationId, isOnline: true },
    });

    const receiptPrinter = printers.find((p) => p.supportsReceipts);
    const kitchenPrinter = printers.find((p) => p.supportsKitchen);

    const jobs: Array<{ printerId: string | null; type: PrintJobType; label: string }> = [];

    if (receiptPrinter) jobs.push({ printerId: receiptPrinter.id, type: "RECEIPT", label: PRINT_JOBS.RECEIPT });
    if (kitchenPrinter) jobs.push({ printerId: kitchenPrinter.id, type: "KITCHEN_TICKET", label: PRINT_JOBS.KITCHEN_TICKET });

    if (
      printers.find((p) => p.supportsLabels) &&
      ["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER"].includes(order.fulfillmentType)
    ) {
      const labelPrinter = printers.find((p) => p.supportsLabels)!;
      jobs.push({ printerId: labelPrinter.id, type: "LABEL", label: PRINT_JOBS.LABEL });
    }

    for (const j of jobs) {
      await this.enqueuePrintJob(order, j.printerId, j.type, j.label);
    }
  }

  private async triggerAcceptedPrints(orderId: string, tenantId: string, locationId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;

    const printers = await this.prisma.printer.findMany({
      where: { locationId, isOnline: true },
    });
    const kitchenPrinter = printers.find((p) => p.supportsKitchen);
    if (kitchenPrinter) {
      await this.enqueuePrintJob(order, kitchenPrinter.id, "KITCHEN_TICKET", PRINT_JOBS.KITCHEN_TICKET);
    }
  }

  private async triggerCancelTicket(
    orderId: string,
    tenantId: string,
    locationId: string,
    cancelReason?: string,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const printer = await this.prisma.printer.findFirst({
      where: { locationId, isOnline: true, supportsKitchen: true },
    });

    const cancelJob = await this.prisma.printJob.create({
      data: {
        tenantId,
        locationId,
        orderId,
        printerId: printer?.id ?? null,
        type: "CANCEL_TICKET",
        status: "QUEUED",
        payload: {
          type: "CANCEL_TICKET",
          orderId,
          displayId: order.displayId,
          platform: order.platform,
          reason: cancelReason ?? null,
          cancelledAt: new Date().toISOString(),
        } as any,
      },
    });

    await this.printQueue.add(
      PRINT_JOBS.CANCEL_TICKET,
      { jobId: cancelJob.id, tenantId, locationId, printerId: printer?.id ?? null },
      { jobId: `print-${cancelJob.id}`, attempts: 3 },
    );
  }

  private async bumpKdsTickets(orderId: string) {
    const bumpedAt = new Date();
    const result = await this.prisma.kdsTicket.updateMany({
      where: { orderId, bumpedAt: null },
      data: { bumpedAt },
    });

    if (result.count === 0) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { tenantId: true, locationId: true },
    });
    if (!order) return;

    await this.events.publish("kds:ticket:bumped", order.locationId, order.tenantId, {
      orderId,
      bumpedAt: bumpedAt.toISOString(),
    });
  }

  private async createKdsTickets(orderId: string, locationId: string) {
    const screens = await this.prisma.kdsScreen.findMany({
      where: { locationId, isActive: true },
    });

    if (screens.length === 0) return;

    for (const screen of screens) {
      try {
        await this.prisma.kdsTicket.create({
          data: { kdsScreenId: screen.id, orderId },
        });
      } catch {
        // @@unique([kdsScreenId, orderId]) — safe to ignore if already exists
      }
    }

    // Look up the order's tenantId for the event (needed by event publisher)
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { tenantId: true, displayId: true, platform: true, fulfillmentType: true },
    });
    if (!order) return;

    await this.events.publish("kds:order:new", locationId, order.tenantId, {
      orderId,
      screenIds: screens.map((s) => s.id),
      displayId: order.displayId,
      platform: order.platform,
      fulfillmentType: order.fulfillmentType,
    });
  }

  private async enqueuePrintJob(
    order: any,
    printerId: string | null,
    type: PrintJobType,
    queueJobName: string,
  ) {
    const job = await this.prisma.printJob.create({
      data: {
        tenantId: order.tenantId,
        locationId: order.locationId,
        orderId: order.id,
        printerId,
        type,
        status: "QUEUED",
        payload: this.buildPrintPayload(type, order),
      },
    });

    await this.printQueue.add(
      queueJobName,
      { jobId: job.id, tenantId: order.tenantId, locationId: order.locationId, printerId },
      { jobId: `print-${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } },
    );

    this.logger.debug(`[${order.id}] Print job queued: ${type} → printer:${printerId ?? "any"}`);
  }

  private buildPrintPayload(type: PrintJobType, order: any): object {
    const customer = order.customerInfo as Record<string, any>;
    const base = {
      type,
      orderId: order.id,
      displayId: order.displayId,
      platform: order.platform,
      orderSource: order.orderSource,
      fulfillmentType: order.fulfillmentType,
      customerName: customer?.name ?? "",
      items: (order.items ?? []).map((i: any) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        totalPrice: Number(i.totalPrice),
        modifiers: (i.modifiers ?? []),
        notes: i.notes ?? null,
      })),
      total: Number(order.total),
      specialInstructions: order.specialInstructions ?? null,
      scheduledFor: order.scheduledFor?.toISOString() ?? null,
      printedAt: new Date().toISOString(),
    };

    if (type === "RECEIPT") {
      return {
        ...base,
        subtotal: Number(order.subtotal),
        taxAmount: Number(order.taxAmount),
        deliveryFee: Number(order.deliveryFee),
        discount: Number(order.discount),
      };
    }

    return base;
  }
}
