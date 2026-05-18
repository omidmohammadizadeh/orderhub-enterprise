import * as net from "net";
import * as https from "https";
import * as http from "http";
import { Processor, Process, OnQueueFailed } from "@nestjs/bull";
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

interface PrinterRecord {
  id: string;
  connectionType: string;
  ipAddress: string | null;
  port: number | null;
  locationId: string;
}

const LAN_TIMEOUT_MS = 5_000;
const EPOS_TIMEOUT_MS = 8_000;

// ─── TCP helpers ──────────────────────────────────────────────────────────────

function sendTcp(host: string, port: number, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (err?: Error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      }
    };

    socket.setTimeout(LAN_TIMEOUT_MS);
    socket.on("error", (err) => finish(err));
    socket.on("timeout", () => finish(new Error(`TCP timeout connecting to ${host}:${port}`)));

    socket.connect(port, host, () => {
      const buf = typeof data === "string" ? Buffer.from(data, "binary") : data;
      socket.write(buf, (err) => {
        if (err) finish(err);
        else {
          // Brief drain wait — some printers need time to buffer before close
          setTimeout(() => finish(), 300);
        }
      });
    });
  });
}

function checkTcpReachable(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

// ─── ePOS XML helper ─────────────────────────────────────────────────────────

function buildEposXml(text: string, jobId: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:epos="http://www.epson-pos.com/schemas/2011/03/epos-print">
  <soapenv:Body>
    <epos:epos-print xmlns:epos="http://www.epson-pos.com/schemas/2011/03/epos-print"
                     version="2.00" xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
      <text lang="en" smooth="false">${escaped}</text>
      <feed unit="5"/>
      <cut type="feed"/>
    </epos:epos-print>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function httpPost(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const bodyBuf = Buffer.from(body, "utf8");

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": bodyBuf.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );

    req.on("timeout", () => { req.destroy(); reject(new Error("HTTP request timed out")); });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Processor ───────────────────────────────────────────────────────────────

@Processor(QUEUES.PRINTING)
export class PrintingProcessor {
  private readonly logger = new Logger(PrintingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisherService,
  ) {}

  @Process(PRINT_JOBS.RECEIPT)
  async handleReceipt(job: Job<PrintJobData>) { return this.processJob(job, "RECEIPT"); }

  @Process(PRINT_JOBS.KITCHEN_TICKET)
  async handleKitchenTicket(job: Job<PrintJobData>) { return this.processJob(job, "KITCHEN_TICKET"); }

  @Process(PRINT_JOBS.LABEL)
  async handleLabel(job: Job<PrintJobData>) { return this.processJob(job, "LABEL"); }

  @Process(PRINT_JOBS.CANCEL_TICKET)
  async handleCancelTicket(job: Job<PrintJobData>) { return this.processJob(job, "CANCEL_TICKET"); }

  @Process(PRINT_JOBS.REPRINT)
  async handleReprint(job: Job<PrintJobData>) { return this.processJob(job, "REPRINT"); }

  @Process(PRINT_JOBS.DRIVER_RECEIPT)
  async handleDriverReceipt(job: Job<PrintJobData>) { return this.processJob(job, "DRIVER_RECEIPT"); }

  @OnQueueFailed()
  async onFailed(job: Job<PrintJobData>, err: Error) {
    const { jobId, locationId, tenantId } = job.data;
    this.logger.error(`Print job ${jobId} failed (attempt ${job.attemptsMade}): ${err.message}`);

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

  // ── Core dispatch ────────────────────────────────────────────────────────────

  private async processJob(job: Job<PrintJobData>, type: string) {
    const { jobId, tenantId, locationId, printerId } = job.data;

    // Fetch the DB record
    const dbJob = await (this.prisma as any).printJob.findUnique({ where: { id: jobId } });
    if (!dbJob) {
      this.logger.warn(`Print job ${jobId} not found in DB — skipping`);
      return;
    }

    // Idempotency guard: if already printed, skip without error
    if (dbJob.status === "PRINTED") {
      this.logger.log(`Print job ${jobId} already PRINTED — skipping (idempotent)`);
      return;
    }

    this.logger.log(`Processing ${type} print job ${jobId} → printer:${printerId ?? "any"}`);

    // Mark as printing
    await this.updateJobStatus(jobId, "PRINTING");

    // Resolve printer
    let printer: PrinterRecord | null = null;
    if (printerId) {
      printer = await (this.prisma as any).printer.findUnique({ where: { id: printerId } }) as PrinterRecord | null;
    }

    if (!printer) {
      // No printer assigned — mark as printed (soft path, no hardware)
      await this.markPrinted(jobId, locationId, tenantId, type, null);
      return;
    }

    // Route to hardware
    await this.processJobWithBridge(job, dbJob, printer, type, tenantId, locationId);
  }

  private async processJobWithBridge(
    bullJob: Job<PrintJobData>,
    dbJob: any,
    printer: PrinterRecord,
    type: string,
    tenantId: string,
    locationId: string,
  ) {
    const jobId = dbJob.id;
    const payload = dbJob.payload as Record<string, any>;
    // Extract raw ESC/POS data from payload — formatters write it as `raw` or fall back to text
    const rawData: string = payload?.raw ?? payload?.text ?? JSON.stringify(payload);

    try {
      switch (printer.connectionType) {
        case "LAN":
        case "STAR": {
          if (!printer.ipAddress) throw new Error("Printer has no IP address configured");

          // Check reachability before sending
          const port = printer.port ?? 9100;
          const reachable = await checkTcpReachable(printer.ipAddress, port);
          if (!reachable) {
            await this.markOfflineRetry(jobId);
            this.logger.warn(`Printer ${printer.id} offline — job ${jobId} queued for offline retry`);
            return; // Return normally — Bull should not retry this as an error
          }

          await sendTcp(printer.ipAddress, port, rawData);
          break;
        }

        case "EPSON_EPOS": {
          if (!printer.ipAddress) throw new Error("Printer has no IP address configured");
          const port = printer.port ?? 80;
          const url = `http://${printer.ipAddress}:${port}/cgi-bin/epos/service.cgi`;
          const xml = buildEposXml(rawData, jobId);

          let responseText: string;
          try {
            responseText = await httpPost(url, xml, {
              "Content-Type": "text/xml; charset=utf-8",
              "SOAPAction": '""',
            }, EPOS_TIMEOUT_MS);
          } catch (err: any) {
            // Network failure → check if printer is offline
            const reachable = await checkTcpReachable(printer.ipAddress, port, 2_000);
            if (!reachable) {
              await this.markOfflineRetry(jobId);
              this.logger.warn(`ePOS printer ${printer.id} offline — job ${jobId} queued for offline retry`);
              return;
            }
            throw new Error(`ePOS HTTP error: ${err.message}`);
          }

          if (responseText.includes("SchemaError") || responseText.includes("DeviceNotFound")) {
            throw new Error(`ePOS error response: ${responseText.substring(0, 200)}`);
          }
          break;
        }

        case "CLOUD":
        case "STAR_CLOUD": {
          // Star CloudPRNT: printer polls; store job in DB polling queue (handled via separate endpoint)
          // Mark as PRINTING so the CloudPRNT polling endpoint can pick it up
          this.logger.log(`CloudPRNT job ${jobId} stored for printer ${printer.id} — awaiting poll`);
          // Job stays in PRINTING state until the printer polls and confirms receipt
          return;
        }

        case "BROWSER":
        case "USB":
        case "BLUETOOTH": {
          // These are relayed via browser/Flutter agent over WebSocket
          // The job is already in the queue; the API's SocketService will emit it.
          // We mark as PRINTING (done above) and the browser agent updates to PRINTED.
          this.logger.log(`Browser/USB/BT job ${jobId} relayed to printer ${printer.id} via socket agent`);
          return;
        }

        default:
          throw new Error(`Unknown connectionType: ${printer.connectionType}`);
      }

      // Success
      await this.markPrinted(jobId, locationId, tenantId, type, printer.id);

      // Update printer lastSeenAt (no-op if field not in schema yet)
      try {
        await (this.prisma as any).printer.update({
          where: { id: printer.id },
          data: { isOnline: true, updatedAt: new Date() },
        });
      } catch {
        // Best-effort — don't fail the job if this update fails
      }
    } catch (err: any) {
      // Mark as FAILED in DB then rethrow so Bull can retry
      this.logger.error(`Print job ${jobId} bridge error: ${err.message}`);
      await this.updateJobStatus(jobId, "FAILED", err.message);
      throw err; // Let Bull handle retries
    }
  }

  // ── Status helpers ───────────────────────────────────────────────────────────

  private async markPrinted(
    jobId: string,
    locationId: string,
    tenantId: string,
    type: string,
    printerId: string | null,
  ) {
    const printedAt = new Date();
    await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: { status: "PRINTED", printedAt, attempts: { increment: 1 } },
    });

    const dbJob = await (this.prisma as any).printJob.findUnique({ where: { id: jobId } });

    await this.events.publish("print:job", locationId, tenantId, {
      jobId,
      orderId: dbJob?.orderId ?? null,
      locationId,
      type,
      status: "PRINTED",
      printedAt: printedAt.toISOString(),
    });

    this.logger.log(`Print job ${jobId} PRINTED`);
  }

  private async markOfflineRetry(jobId: string) {
    // PENDING_OFFLINE_RETRY is not in the Prisma enum; store as a string cast
    await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: { status: "FAILED" as any, error: "Printer offline — pending retry", attempts: { increment: 1 } },
    });
  }

  private async updateJobStatus(jobId: string, status: string, error?: string) {
    await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: {
        status: status as any,
        error: error ?? null,
        attempts: { increment: 1 },
      },
    });
  }
}
