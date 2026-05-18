import { Processor, Process, OnQueueFailed, OnQueueCompleted } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { QUEUES, PRINT_JOBS } from "@orderhub/shared";
import { PrismaService } from "../infrastructure/prisma.service";
import { EventPublisherService } from "../infrastructure/event-publisher.service";

interface PrintJobData {
  jobId: string;
  tenantId: string;
  locationId: string;
  printerId: string | null;
}

// The printing processor owns the job lifecycle:
//   QUEUED → PRINTING → PRINTED (or FAILED → RETRYING → PRINTED/FAILED)
// Hardware dispatch is not yet implemented — this processor marks jobs as PRINTED
// after recording the attempt. The hardware transport layer will be a separate
// adapter (ESC/POS TCP, Epson ePOS SDK, Star Cloud PRT) added in a future phase.
@Processor(QUEUES.PRINTING)
export class PrintingProcessor {
  private readonly logger = new Logger(PrintingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisherService,
  ) {}

  @Process(PRINT_JOBS.RECEIPT)
  async handleReceipt(job: Job<PrintJobData>) {
    return this.processJob(job, "RECEIPT");
  }

  @Process(PRINT_JOBS.KITCHEN_TICKET)
  async handleKitchenTicket(job: Job<PrintJobData>) {
    return this.processJob(job, "KITCHEN_TICKET");
  }

  @Process(PRINT_JOBS.LABEL)
  async handleLabel(job: Job<PrintJobData>) {
    return this.processJob(job, "LABEL");
  }

  @Process(PRINT_JOBS.CANCEL_TICKET)
  async handleCancelTicket(job: Job<PrintJobData>) {
    return this.processJob(job, "CANCEL_TICKET");
  }

  @Process(PRINT_JOBS.REPRINT)
  async handleReprint(job: Job<PrintJobData>) {
    return this.processJob(job, "REPRINT");
  }

  @Process(PRINT_JOBS.DRIVER_RECEIPT)
  async handleDriverReceipt(job: Job<PrintJobData>) {
    return this.processJob(job, "DRIVER_RECEIPT");
  }

  @OnQueueFailed()
  async onFailed(job: Job<PrintJobData>, err: Error) {
    const { jobId, locationId, tenantId } = job.data;
    this.logger.error(
      `Print job ${jobId} failed (attempt ${job.attemptsMade}): ${err.message}`,
    );

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
    const newStatus = isLastAttempt ? "FAILED" : "RETRYING";

    await this.updateJobStatus(jobId, newStatus, err.message);

    await this.events.publish("print:job", locationId, tenantId, {
      jobId,
      orderId: null,
      locationId,
      type: job.name,
      status: newStatus,
      printedAt: null,
    });
  }

  private async processJob(job: Job<PrintJobData>, type: string) {
    const { jobId, tenantId, locationId, printerId } = job.data;
    this.logger.log(`Processing ${type} print job ${jobId} → printer:${printerId ?? "any"}`);

    // Mark as printing
    await this.updateJobStatus(jobId, "PRINTING");

    // TODO: Route to hardware driver based on printer.connectionType:
    //   USB → escpos-usb driver
    //   LAN → ESC/POS TCP socket
    //   EPSON_EPOS → Epson ePOS SDK (HTTP)
    //   STAR → Star CloudPRNT
    //   CLOUD → Cloud print relay
    //
    // For now: record as printed. Hardware dispatch is the next phase.
    await new Promise((r) => setTimeout(r, 50)); // simulate brief I/O

    const printedAt = new Date();
    await this.prisma.printJob.update({
      where: { id: jobId },
      data: { status: "PRINTED", printedAt, attempts: { increment: 1 } },
    });

    const printJob = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    await this.events.publish("print:job", locationId, tenantId, {
      jobId,
      orderId: printJob?.orderId ?? null,
      locationId,
      type,
      status: "PRINTED",
      printedAt: printedAt.toISOString(),
    });

    this.logger.log(`Print job ${jobId} marked PRINTED`);
  }

  private async updateJobStatus(
    jobId: string,
    status: string,
    error?: string,
  ) {
    await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        status: status as any,
        error: error ?? null,
        attempts: { increment: 1 },
      },
    });
  }
}
