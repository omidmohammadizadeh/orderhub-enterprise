// Phase AS-2 — SERVER_DIRECT LAN printing.
//
// For LAN printers without a bound PrintAgent, the API itself plays
// the agent's role: every 2 seconds, scan QUEUED + RETRYING-ready
// jobs whose printer is LAN-reachable, claim them atomically, render
// the JSON payload to ESC/POS, push over a raw TCP socket on port
// 9100 (or the printer's configured port), and report PRINTED /
// FAILED through the same lifecycle helpers an agent would.
//
// This is what lets a restaurant plug in an Epson TM-m30 over LAN,
// wire it as the receipt printer, and start printing — zero client
// install. Bluetooth + USB printers fall through to the agent path
// because the API process has no path to those transports.

import * as net from "net";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PrintJobsService } from "./print-jobs.service";
import { renderToEscPos } from "./escpos-renderer";

const PRINT_PORT_DEFAULT = 9100;
const SOCKET_TIMEOUT_MS = 8_000;
const BATCH_LIMIT = 20;

@Injectable()
export class ServerDirectPrintCron {
  private readonly logger = new Logger(ServerDirectPrintCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: PrintJobsService,
  ) {}

  @Cron("*/2 * * * * *")
  async tick() {
    try {
      await this.drainOnce();
    } catch (err: any) {
      this.logger.warn(`server-direct drain failed: ${err.message}`);
    }
  }

  private async drainOnce() {
    // Find LAN printers with no bound agent. These are the ones we own
    // server-side. JSON1 on autoPrintRules doesn't matter here — the
    // upstream createFromOrder already applied the rule filter.
    const printers = await (this.prisma as any).printer.findMany({
      where: {
        agentId: null,
        connectionType: { in: ["LAN", "EPSON_EPOS"] },
        supportsLan: true,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        ipAddress: true,
        port: true,
        paperWidth: true,
        supportsCashDrawer: true,
        isOnline: true,
        defaults: true,
      },
    });
    if (!printers.length) return;

    const printerById = new Map(printers.map((p: any) => [p.id, p]));

    // ── Defensive filters ────────────────────────────────────────────
    // 1. Only touch jobs created in the last 10 minutes. A printer that
    //    was unbound at order-creation time and then bound to an agent
    //    leaves stale QUEUED rows behind; without a TTL the cron would
    //    pick them up after redeploys and print yesterday's tickets
    //    next to today's, which looked to operators like a phantom
    //    "first copy is wrong" duplicate. Anything older is rolled
    //    over to DEAD_LETTERED on a separate sweep, not reprinted.
    // 2. Skip anything an agent has already claimed (claimedByAgentId
    //    set) — defensive against agentId-on-printer races.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const claimable = await (this.prisma as any).printJob.findMany({
      where: {
        status: { in: ["QUEUED"] },
        printerId: { in: printers.map((p: any) => p.id) },
        createdAt: { gte: tenMinutesAgo },
        claimedByAgentId: null,
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_LIMIT,
    });
    if (!claimable.length) return;

    // Claim each row in its own tiny tx so a slow printer doesn't hold
    // the others up.
    for (const job of claimable) {
      const claimed = await (this.prisma as any).printJob.updateMany({
        where: { id: job.id, status: "QUEUED" },
        data: {
          status: "PRINTING",
          claimedAt: new Date(),
        },
      });
      if (claimed.count === 0) continue; // someone else got it (agent race)

      const printer = printerById.get(job.printerId) as any;
      try {
        const buf = renderToEscPos(job.payload, {
          paperWidth: (printer.paperWidth ?? 80) as 58 | 80,
          openCashDrawer:
            !!printer.supportsCashDrawer &&
            !!(job.payload?.openCashDrawer ?? printer.defaults?.openCashDrawer),
          printLogo: !!printer.defaults?.printLogo,
          // Item block sizing + weight, straight off the printer's own
          // settings. These were saved by the settings drawer and read by
          // nothing until now, so "Large" printed identically to "Standard".
          fontScale: printer.defaults?.fontScale,
          modifierScale: printer.defaults?.modifierScale,
          boldItems: printer.defaults?.boldItems,
        });

        for (let copy = 0; copy < (job.copies || 1); copy++) {
          await this.sendOverTcp(
            printer.ipAddress,
            printer.port ?? PRINT_PORT_DEFAULT,
            buf,
          );
        }

        await (this.prisma as any).printJob.update({
          where: { id: job.id },
          data: {
            status: "PRINTED",
            printedAt: new Date(),
            nextRetryAt: null,
          },
        });
        await (this.prisma as any).printer.update({
          where: { id: job.printerId },
          data: { isOnline: true },
        });
      } catch (err: any) {
        const failureReason = this.classifyError(err);
        await (this.prisma as any).printJob.update({
          where: { id: job.id },
          data: {
            status: "RETRYING",
            attempts: { increment: 1 },
            failureReason,
            lastError: String(err?.message ?? err),
            error: String(err?.message ?? err),
            nextRetryAt: new Date(
              Date.now() + Math.min(60_000, 1000 * ((job.attempts ?? 0) + 1) ** 2),
            ),
          },
        });
        if (failureReason === "printer_offline") {
          await (this.prisma as any).printer.update({
            where: { id: job.printerId },
            data: { isOnline: false },
          });
        }
      }
    }
  }

  private sendOverTcp(host: string, port: number, buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.connect(port, host, () => {
        socket.write(buf, (err) => {
          if (err) {
            socket.destroy();
            reject(err);
            return;
          }
          // Wait a beat to let the printer flush before we close.
          setTimeout(() => {
            socket.end();
            resolve();
          }, 300);
        });
      });
      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("printer connect/write timeout"));
      });
    });
  }

  private classifyError(err: any): string {
    const m = String(err?.message ?? err).toLowerCase();
    if (
      m.includes("econnrefused") ||
      m.includes("timeout") ||
      m.includes("ehostunreach") ||
      m.includes("network")
    ) {
      return "printer_offline";
    }
    if (m.includes("payload") || m.includes("undefined")) return "bad_payload";
    return "unknown";
  }
}
