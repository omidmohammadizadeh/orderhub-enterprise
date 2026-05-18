import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import type { PrintJobType } from "@orderhub/database";
import { QUEUES, PRINT_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { buildReceiptPayload } from "./formatters/receipt.formatter";
import { buildKitchenTicketPayload } from "./formatters/kitchen-ticket.formatter";
import { buildLabelPayloads } from "./formatters/label.formatter";

@Injectable()
export class PrintQueueService {
  private readonly logger = new Logger(PrintQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    @InjectQueue(QUEUES.PRINTING) private readonly printQueue: Queue,
  ) {}

  // Enqueue all jobs triggered by a new order arriving
  async enqueueForNewOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;

    const printers = await this.prisma.printer.findMany({
      where: { locationId: order.locationId, isOnline: true },
    });

    const receiptPrinter = printers.find((p) => p.supportsReceipts);
    const kitchenPrinter = printers.find((p) => p.supportsKitchen);
    const labelPrinter = printers.find((p) => p.supportsLabels);

    const jobs: Array<{ printerId: string | null; type: PrintJobType; payload: object }> = [];

    if (receiptPrinter) {
      jobs.push({
        printerId: receiptPrinter.id,
        type: "RECEIPT",
        payload: buildReceiptPayload(order),
      });
    }

    if (kitchenPrinter) {
      jobs.push({
        printerId: kitchenPrinter.id,
        type: "KITCHEN_TICKET",
        payload: buildKitchenTicketPayload(order),
      });
    }

    if (labelPrinter && ["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER"].includes(order.fulfillmentType)) {
      for (const payload of buildLabelPayloads(order)) {
        jobs.push({ printerId: labelPrinter.id, type: "LABEL", payload });
      }
    }

    await Promise.all(jobs.map((j) => this.createJob(order.tenantId, order.locationId, orderId, j.printerId, j.type, j.payload)));
  }

  // Enqueue cancel ticket when order is cancelled
  async enqueueCancel(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const printer = await this.prisma.printer.findFirst({
      where: { locationId: order.locationId, isOnline: true, supportsKitchen: true },
    });

    await this.createJob(order.tenantId, order.locationId, orderId, printer?.id ?? null, "CANCEL_TICKET", {
      type: "CANCEL_TICKET",
      orderId,
      displayId: order.displayId,
      reason: order.cancelReason,
      cancelledAt: order.cancelledAt?.toISOString() ?? new Date().toISOString(),
    });
  }

  async reprint(jobId: string): Promise<void> {
    const original = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!original) return;

    await this.createJob(
      original.tenantId,
      original.locationId,
      original.orderId ?? undefined,
      original.printerId ?? null,
      "REPRINT",
      { ...original.payload as object, reprinted: true, reprintedAt: new Date().toISOString() },
    );
  }

  private async createJob(
    tenantId: string,
    locationId: string,
    orderId: string | undefined,
    printerId: string | null,
    type: PrintJobType,
    payload: object,
  ) {
    const job = await this.prisma.printJob.create({
      data: {
        tenantId,
        locationId,
        orderId: orderId ?? null,
        printerId,
        type,
        payload: payload as any,
        status: "QUEUED",
      },
    });

    await this.printQueue.add(
      type.toLowerCase().replace("_", "-"),
      { jobId: job.id, tenantId, locationId, printerId },
      { jobId: `print-${job.id}` },
    );

    this.socket.emitToLocation(locationId, "print:job", {
      jobId: job.id,
      orderId: orderId ?? null,
      locationId,
      type,
      status: "QUEUED",
      printedAt: null,
    });

    this.logger.debug(`Print job queued: ${type} → printer:${printerId} for order:${orderId}`);
    return job;
  }
}
