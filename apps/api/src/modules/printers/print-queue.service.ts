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
import { computeVisitCountForOrder } from "../orders/customer-visit.helper";

@Injectable()
export class PrintQueueService {
  private readonly logger = new Logger(PrintQueueService.name);

  /**
   * Kitchen-language names for this order's products, or an empty map.
   *
   * Gated on the location's own setting and returns early when it is off, so
   * the overwhelming majority of shops — which print English — pay one cheap
   * settings read that is already loaded, and no extra query at all.
   */
  private async kitchenNamesFor(
    order: any,
  ): Promise<{ items: Map<string, string>; modifiers: Map<string, string> }> {
    const empty = { items: new Map<string, string>(), modifiers: new Map<string, string>() };
    if (!order?.locationId) return empty;
    try {
      const loc = await this.prisma.location.findUnique({
        where: { id: order.locationId },
        select: { settings: true },
      });
      const on =
        ((loc?.settings ?? {}) as Record<string, unknown>)
          .kitchenTicketSecondLanguage === true;
      if (!on) return empty;

      const ids: string[] = Array.from(
        new Set<string>(
          (order.items ?? [])
            .map((i: any) => i.menuItemId)
            .filter((id: any): id is string => typeof id === "string" && !!id),
        ),
      );
      if (ids.length) {
        const rows = await this.prisma.menuItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, secondLanguageName: true },
        });
        for (const r of rows) {
          // Only real translations go in. A blank means "not translated yet"
          // and the ticket keeps printing English, so a shop can translate its
          // menu a few items at a time.
          const n = (r.secondLanguageName ?? "").trim();
          if (n) empty.items.set(r.id, n);
        }
      }

      // Modifier names on the order line, matched by name (see the formatter).
      // Scoped to this order's brand so one tenant's translation can never
      // reach another's ticket.
      const modNames: string[] = Array.from(
        new Set<string>(
          (order.items ?? [])
            .flatMap((i: any) => i.modifiers ?? [])
            .map((m: any) => String(m?.name ?? "").trim())
            .filter(Boolean),
        ),
      );
      if (modNames.length && order.brandId) {
        const mods = await this.prisma.modifierOption.findMany({
          where: {
            name: { in: modNames },
            group: { brandId: order.brandId },
            NOT: { secondLanguageName: null },
          },
          select: { name: true, secondLanguageName: true },
        });
        for (const m of mods) {
          const n = (m.secondLanguageName ?? "").trim();
          if (n) empty.modifiers.set(m.name.trim(), n);
        }
      }
      return empty;
    } catch (e: any) {
      // A ticket that prints in English beats a ticket that does not print.
      this.logger.warn(
        `kitchen-language lookup failed for order ${order?.id}: ${e?.message ?? e}`,
      );
      return { items: new Map<string, string>(), modifiers: new Map<string, string>() };
    }
  }

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

    // Phase AW-30 — single source of truth for visit count. Same
    // helper used by the orders board + print-routing service so all
    // three views show the same number. Scoped to (tenantId, brandId)
    // so cross-brand orders don't inflate the count.
    const visitCount = await computeVisitCountForOrder(this.prisma, {
      tenantId: order.tenantId,
      brandId: (order as any).brandId ?? null,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      postcode: order.postcode,
      platform: order.platform,
      orderSource: order.orderSource,
      integrationSource: order.integrationSource,
      viaHubrise: order.viaHubrise,
    });

    if (receiptPrinter) {
      jobs.push({
        printerId: receiptPrinter.id,
        type: "RECEIPT",
        payload: buildReceiptPayload(order, visitCount),
      });
    }

    if (kitchenPrinter) {
      jobs.push({
        printerId: kitchenPrinter.id,
        type: "KITCHEN_TICKET",
        payload: await (async () => {
          const names = await this.kitchenNamesFor(order);
          return buildKitchenTicketPayload(
            order,
            visitCount,
            names.items,
            names.modifiers,
          );
        })(),
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

  // Enqueue an already-created print job record (used for test prints, retries)
  async enqueueRawJob(
    jobId: string,
    tenantId: string,
    locationId: string,
    printerId: string | null,
  ): Promise<{ jobId: string }> {
    await this.printQueue.add(
      PRINT_JOBS.RECEIPT,
      { jobId, tenantId, locationId, printerId },
      { jobId: `print-${jobId}`, attempts: 1 },
    );
    return { jobId };
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
