import * as net from "net";
import * as http from "http";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { QUEUES, PRINT_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PrintersService } from "./printers.service";
import { PrintJobsService } from "./print-jobs.service";

const PROBE_TIMEOUT_MS = 3_000;
const EPOS_PROBE_TIMEOUT_MS = 4_000;

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.connect(port, host, () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

function probeEpos(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: host, port, path: "/cgi-bin/epos/service.cgi", method: "GET", timeout: EPOS_PROBE_TIMEOUT_MS },
      () => resolve(true),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

@Injectable()
export class PrinterHeartbeatCron {
  private readonly logger = new Logger(PrinterHeartbeatCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly printersService: PrintersService,
    private readonly printJobs: PrintJobsService,
    @InjectQueue(QUEUES.PRINTING) private readonly printQueue: Queue,
  ) {}

  // Phase AS-1 — un-claim stuck print jobs (agent crashed mid-print)
  // every 30s so they go back to QUEUED and another agent can take
  // them. Matches the 15s heartbeat × 4 missed beats grace.
  @Cron("*/30 * * * * *")
  async releaseStalePrintJobs() {
    try {
      await this.printJobs.releaseStaleClaims();
    } catch (err: any) {
      this.logger.warn(`reaper failed: ${err.message}`);
    }
  }

  // Probe every 30 seconds — fast enough to detect reboots, slow enough to not flood
  @Cron("*/30 * * * * *")
  async probeAll() {
    const printers = await this.prisma.printer.findMany({
      where: {
        connectionType: { in: ["LAN", "STAR", "EPSON_EPOS"] },
        isActive: true,
      },
      select: { id: true, connectionType: true, ipAddress: true, port: true, isOnline: true, locationId: true },
    });

    await Promise.allSettled(printers.map((p) => this.probeOne(p)));
  }

  private async probeOne(printer: {
    id: string;
    connectionType: string;
    ipAddress: string | null;
    port: number | null;
    isOnline: boolean;
    locationId: string;
  }) {
    if (!printer.ipAddress) return;

    let reachable: boolean;
    try {
      if (printer.connectionType === "EPSON_EPOS") {
        reachable = await probeEpos(printer.ipAddress, printer.port ?? 80);
      } else {
        reachable = await probeTcp(printer.ipAddress, printer.port ?? 9100);
      }
    } catch {
      reachable = false;
    }

    // Always record heartbeat timestamp so staff health panel can detect stale probes
    const heartbeatPayload = JSON.stringify({ lastHeartbeatAt: new Date().toISOString() });
    await this.prisma.$executeRaw`
      UPDATE "Printer"
      SET metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || ${heartbeatPayload}::jsonb
      WHERE id = ${printer.id}
    `;

    const wasOnline = printer.isOnline;
    if (reachable === wasOnline) return; // No status change — skip setOnlineStatus

    this.logger.log(
      `Printer ${printer.id} status changed: ${wasOnline ? "ONLINE" : "OFFLINE"} → ${reachable ? "ONLINE" : "OFFLINE"}`,
    );

    await this.printersService.setOnlineStatus(printer.id, reachable);

    // When a printer comes back online, retry any FAILED jobs targeting it
    if (reachable && !wasOnline) {
      await this.retryOfflineJobs(printer.id, printer.locationId);
    }
  }

  private async retryOfflineJobs(printerId: string, locationId: string) {
    const failedJobs = await (this.prisma as any).printJob.findMany({
      where: {
        printerId,
        status: "FAILED",
        error: { contains: "offline" },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });

    if (failedJobs.length === 0) return;

    this.logger.log(`Replaying ${failedJobs.length} offline-buffered jobs for printer ${printerId}`);

    for (const job of failedJobs) {
      await this.printQueue.add(
        job.type ?? PRINT_JOBS.RECEIPT,
        {
          jobId: job.id,
          tenantId: job.tenantId,
          locationId,
          printerId,
        },
        {
          jobId: `retry-${job.id}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        },
      );

      // Reset to PENDING so the worker picks it up fresh
      await (this.prisma as any).printJob.update({
        where: { id: job.id },
        data: { status: "PENDING", error: null },
      });
    }
  }
}
