// Phase AS-1 — PrintJob lifecycle service.
//
// Owns:
//   • Creating PrintJob rows from PrintRoutingService targets.
//   • Atomic claim() so two agents racing the same QUEUED job is safe.
//   • Lifecycle transitions QUEUED → CLAIMED → PRINTING → PRINTED|FAILED
//     with retry semantics (FAILED below maxRetries flips back to
//     QUEUED with attempts++).
//   • Reprint — always creates a NEW PrintJob row, never mutates old.
//   • Test print — synthetic PrintTarget so a printer can be verified
//     during setup before any real order exists.
//
// Endpoints in print-jobs.controller.ts call these methods.
//
// Idempotency: every create accepts an optional idempotencyKey. If
// the caller (Flutter app offline outbox / web client retry) replays
// the same POST, the unique constraint on PrintJob.idempotencyKey
// dedupes silently and we return the existing row.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PrintRoutingService, type PrintTarget } from "./print-routing.service";

export interface CreateJobsFromOrderDto {
  orderId: string;
  trigger:
    | "ORDER_RECEIVED"
    | "ORDER_ACCEPTED"
    | "ORDER_PREPARING"
    | "ORDER_READY"
    | "MANUAL_ONLY";
  idempotencyKeyPrefix?: string;
}

export interface ClaimDto {
  agentId: string;
  printerIds?: string[];
  locationId?: string;
  limit?: number;
}

export interface ReprintDto {
  orderId: string;
  types: ("CUSTOMER_RECEIPT" | "KITCHEN_TICKET" | "DRIVER_SLIP")[];
}

@Injectable()
export class PrintJobsService {
  private readonly logger = new Logger(PrintJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: PrintRoutingService,
  ) {}

  // ── Create jobs from a routed order ─────────────────────────────────

  async createFromOrder(dto: CreateJobsFromOrderDto): Promise<string[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (!order || !order.locationId) {
      throw new NotFoundException("Order not found");
    }

    const targets = await this.routing.resolveForOrder(dto.orderId, {
      trigger: dto.trigger,
    });
    if (!targets.length) return [];

    const created: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const idempotencyKey = dto.idempotencyKeyPrefix
        ? `${dto.idempotencyKeyPrefix}:${i}`
        : `order:${dto.orderId}:${dto.trigger}:${t.type}:${t.stationId ?? "-"}`;

      try {
        const row = await (this.prisma as any).printJob.create({
          data: {
            tenantId: order.tenantId,
            locationId: order.locationId,
            orderId: dto.orderId,
            printerId: t.printerId,
            stationId: t.stationId,
            type: t.type,
            status: "QUEUED",
            payload: t.payload,
            copies: t.copies,
            trigger: dto.trigger,
            routeKey: t.routeKey,
            idempotencyKey,
          },
        });
        created.push(row.id);
      } catch (err: any) {
        // Unique idempotencyKey collision — replay path. Fetch the
        // existing row and use that id so the caller can track it.
        if (err?.code === "P2002") {
          const existing = await (this.prisma as any).printJob.findUnique({
            where: { idempotencyKey },
            select: { id: true },
          });
          if (existing) created.push(existing.id);
          continue;
        }
        throw err;
      }
    }
    this.logger.log(
      `PrintJobs created for order ${dto.orderId} (${dto.trigger}): ${created.length}`,
    );
    return created;
  }

  // ── Reprint ─────────────────────────────────────────────────────────
  //
  // Always emits NEW rows so the audit trail is intact. Reprints are
  // treated as MANUAL_ONLY trigger because the operator pressed a
  // button — they're not part of an automatic flow.

  async reprint(dto: ReprintDto): Promise<string[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (!order || !order.locationId) {
      throw new NotFoundException("Order not found");
    }

    const targets = await this.routing.resolveForOrder(dto.orderId, {
      trigger: "MANUAL_ONLY",
    });
    const filtered = targets.filter((t) =>
      dto.types.includes(t.type as any),
    );
    if (!filtered.length) return [];

    const created: string[] = [];
    for (const t of filtered) {
      const row = await (this.prisma as any).printJob.create({
        data: {
          tenantId: order.tenantId,
          locationId: order.locationId,
          orderId: dto.orderId,
          printerId: t.printerId,
          stationId: t.stationId,
          type: "REPRINT",
          status: "QUEUED",
          payload: { ...t.payload, reprintOf: t.type, reprintAt: new Date() },
          copies: t.copies,
          trigger: "MANUAL_ONLY",
          routeKey: t.routeKey,
        },
      });
      created.push(row.id);
    }
    return created;
  }

  // ── Test print ──────────────────────────────────────────────────────
  //
  // Synthetic PrintJob targeting a specific printer. Used during setup
  // to verify the printer is reachable, paper width is right, cash
  // drawer kicks open, etc. Payload carries the bits the operator
  // asked for: logo, printer name, location name, datetime, QR code,
  // open-cash-drawer flag.

  async createTestPrint(args: {
    tenantId: string;
    printerId: string;
  }): Promise<string> {
    const printer = await (this.prisma as any).printer.findFirst({
      where: { id: args.printerId, tenantId: args.tenantId },
      include: {
        location: { select: { id: true, name: true, addressLine1: true } },
      },
    });
    if (!printer) throw new NotFoundException("Printer not found");

    const row = await (this.prisma as any).printJob.create({
      data: {
        tenantId: args.tenantId,
        locationId: printer.locationId,
        printerId: printer.id,
        type: "TEST_PRINT",
        status: "QUEUED",
        copies: 1,
        trigger: "MANUAL_ONLY",
        routeKey: `loc:${printer.locationId}|printer:${printer.id}|station:_`,
        payload: {
          kind: "TEST_PRINT",
          logoUrl: null, // bridge resolves from tenant branding
          printerName: printer.name,
          locationName: printer.location?.name ?? null,
          locationAddress: printer.location?.addressLine1 ?? null,
          datetime: new Date().toISOString(),
          message:
            "Order Hub test print — if you can read this, your printer is wired correctly.",
          qrCode: `https://orderhubsolutions.com/printers/${printer.id}`,
          openCashDrawer: !!printer.supportsCashDrawer,
          paperWidth: printer.paperWidth ?? 80,
        },
      },
    });
    this.logger.log(`Test print queued for printer ${printer.id}`);
    return row.id;
  }

  // ── Agent: claim ────────────────────────────────────────────────────
  //
  // Atomic. Uses Postgres SKIP LOCKED so two agents racing the same
  // QUEUED job is safe; the loser gets zero rows back.

  async claim(dto: ClaimDto) {
    const limit = Math.min(Math.max(dto.limit ?? 5, 1), 25);
    const printerFilter = dto.printerIds?.length
      ? `AND "printerId" = ANY($2::text[])`
      : "";
    const locFilter = dto.locationId ? `AND "locationId" = $3` : "";

    // We do this in raw SQL so we can use FOR UPDATE SKIP LOCKED — the
    // Prisma client doesn't expose that lock mode.
    const params: any[] = [limit];
    if (dto.printerIds?.length) params.push(dto.printerIds);
    if (dto.locationId) {
      if (!dto.printerIds?.length) params.push(null); // placeholder for $2
      params.push(dto.locationId);
    }

    // Two-step: SELECT FOR UPDATE SKIP LOCKED → UPDATE that subset.
    // Prisma's $transaction with $queryRawUnsafe works.
    const rows = await this.prisma.$transaction(async (tx) => {
      const locked: any[] = await (tx as any).$queryRawUnsafe(
        `SELECT id FROM print_jobs
         WHERE status IN ('QUEUED','RETRYING')
           ${printerFilter}
           ${locFilter}
         ORDER BY "createdAt" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        ...params,
      );
      if (!locked.length) return [];

      const ids = locked.map((r: any) => r.id);
      await (tx as any).printJob.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "CLAIMED",
          claimedByAgentId: dto.agentId,
          claimedAt: new Date(),
        },
      });
      return (tx as any).printJob.findMany({ where: { id: { in: ids } } });
    });
    return rows;
  }

  // ── Agent: lifecycle transitions ────────────────────────────────────

  async markStarted(jobId: string, agentId: string) {
    const job = await this.requireClaimedBy(jobId, agentId);
    return (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: { status: "PRINTING" },
    });
  }

  async markPrinted(jobId: string, agentId: string) {
    await this.requireClaimedBy(jobId, agentId);
    return (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: { status: "PRINTED", printedAt: new Date() },
    });
  }

  async markFailed(
    jobId: string,
    agentId: string,
    error: string,
    retryable: boolean,
  ) {
    const job = await this.requireClaimedBy(jobId, agentId);
    const attempts = job.attempts + 1;
    const willRetry = retryable && attempts < (job.maxRetries ?? 3);
    return (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: {
        attempts,
        error,
        status: willRetry ? "QUEUED" : "FAILED",
        claimedByAgentId: null,
        claimedAt: null,
      },
    });
  }

  // ── Reaper ──────────────────────────────────────────────────────────
  //
  // Cron-callable. Re-queues jobs that an agent claimed but never
  // completed (process crashed mid-print). 60s window matches a 15s
  // heartbeat × 4 missed beats.

  async releaseStaleClaims() {
    const cutoff = new Date(Date.now() - 60_000);
    const { count } = await (this.prisma as any).printJob.updateMany({
      where: {
        status: { in: ["CLAIMED", "PRINTING"] },
        claimedAt: { lt: cutoff },
      },
      data: {
        status: "QUEUED",
        claimedByAgentId: null,
        claimedAt: null,
      },
    });
    if (count > 0) {
      this.logger.warn(`Released ${count} stale print-job claims`);
    }
    return { released: count };
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async requireClaimedBy(jobId: string, agentId: string) {
    const job = await (this.prisma as any).printJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException("Job not found");
    if (job.claimedByAgentId !== agentId) {
      throw new BadRequestException(
        "Job is not claimed by this agent (claim expired or stolen)",
      );
    }
    return job;
  }
}
