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
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PrintRoutingService, type PrintTarget } from "./print-routing.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

// Client-reported print outcome (used for the Logs feed). Success prints are
// already logged server-side via markOrderPrinted; the client posts here for
// FAILURES and test prints, which the server can't otherwise see.
export interface PrintReportDto {
  ok: boolean;
  orderId?: string;
  displayId?: string;
  printerName?: string;
  message?: string;
  kind?: "order" | "auto" | "test" | "reprint";
}

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
    private readonly socket: SocketService,
    private readonly events: EventEmitter2,
  ) {}

  // Fire a PRINTING row into the activity feed (Logs page). Best-effort:
  // ActivityLogService listens for "activity.log" and never throws. Emitting
  // an event keeps this service decoupled from the logs module.
  private logPrint(entry: {
    tenantId: string;
    locationId?: string | null;
    brandId?: string | null;
    status: "SUCCESS" | "ERROR" | "INFO";
    action: string;
    message: string;
    details?: Record<string, unknown>;
  }): void {
    try {
      this.events.emit("activity.log", { category: "PRINTING", ...entry });
    } catch {
      // never let logging break the print flow
    }
  }

  // ── Auto-print rule evaluator ───────────────────────────────────────
  //
  // Each printer carries `autoPrintRules: PrintAutoRule[]` JSON. This
  // helper answers "should this printer print on this trigger?" and
  // returns the configured copy count. Used by createFromOrder to
  // narrow PrintRoutingService's targets to printers actually wired
  // to react.
  //
  // Shape stored in the JSON column:
  //   [
  //     { trigger: "ORDER_ACCEPTED", copies: 1 },
  //     { trigger: "ORDER_READY",    copies: 2 }
  //   ]
  //
  // MANUAL_ONLY in the rules means "never auto-print on any trigger,
  // only respond to operator reprint clicks". A printer with an empty
  // array prints nothing automatically — same effect.
  private matchAutoRule(
    rules: unknown,
    trigger: string,
  ): { matches: boolean; copies: number } {
    if (!Array.isArray(rules)) return { matches: false, copies: 1 };
    for (const r of rules) {
      if (r?.trigger === trigger) {
        return { matches: true, copies: Math.max(1, Number(r.copies) || 1) };
      }
    }
    return { matches: false, copies: 1 };
  }

  // ── Create jobs from a routed order ─────────────────────────────────

  async createFromOrder(dto: CreateJobsFromOrderDto): Promise<string[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        scheduledFor: true,
        scheduledAt: true,
      },
    });
    if (!order || !order.locationId) {
      throw new NotFoundException("Order not found");
    }

    // Phase AS-2 — scheduled orders never auto-print on ORDER_RECEIVED.
    // The operator clicks "Start preparing now" which routes through
    // ORDER_ACCEPTED later. A future cron will pick the scheduled time
    // up and synthesise the same trigger, but that's a separate job.
    if (dto.trigger === "ORDER_RECEIVED" && this.isScheduledForFuture(order)) {
      this.logger.log(
        `Skipping ORDER_RECEIVED print for scheduled order ${dto.orderId}`,
      );
      return [];
    }

    const targets = await this.routing.resolveForOrder(dto.orderId, {
      trigger: dto.trigger,
    });
    if (!targets.length) return [];

    // Phase AS-2 — apply each printer's autoPrintRules. A target whose
    // printer doesn't have a matching rule is dropped (no auto-print
    // for this trigger). Receipts/driver slips inherit the implicit
    // rule "print on the first trigger after the order is real":
    // ORDER_RECEIVED for marketplace orders, ORDER_ACCEPTED for POS.
    const filtered = await this.filterTargetsByAutoRules(targets, dto.trigger);
    if (!filtered.length) return [];

    // Phase AU follow-up — every status transition (ACCEPTED →
    // PREPARING → READY) used to re-fire the full target list, which
    // meant the customer receipt and driver slip printed three times.
    // Receipts and slips are "print once per order" by nature; only
    // KITCHEN_TICKET legitimately benefits from re-firing because
    // different stations may opt-in via autoPrintRules at different
    // triggers. Look up any existing CUSTOMER_RECEIPT / DRIVER_SLIP
    // PrintJobs for this order and drop those types from the new
    // batch. KITCHEN_TICKET stays subject to its per-printer
    // autoPrintRules.
    const existing = await (this.prisma as any).printJob.findMany({
      where: {
        orderId: dto.orderId,
        type: { in: ["CUSTOMER_RECEIPT", "DRIVER_SLIP"] },
      },
      select: { type: true },
    });
    const alreadyPrinted = new Set<string>(existing.map((r: any) => r.type));
    const deduped = filtered.filter((t) => {
      if (t.type === "CUSTOMER_RECEIPT" || t.type === "DRIVER_SLIP") {
        return !alreadyPrinted.has(t.type);
      }
      return true;
    });
    if (!deduped.length) return [];

    const created: string[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const t = deduped[i]!;
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
        // TEMP DEBUG (remove once receipt template is confirmed correct
        // in production). Dumps every field the print bridge will see
        // for this job — lets us tell at a glance whether the routing
        // is shipping the brand banner, delivery address, fee, notes,
        // etc., or whether the renderer is dropping them.
        this.logger.log(
          `PrintJob ${row.id} type=${row.type} payload-keys=[${Object.keys(
            t.payload ?? {},
          ).join(",")}] payload-preview=${JSON.stringify(
            scrubPayloadForLog(t.payload),
          )}`,
        );
        // Phase AS-2 — surface the new job to listening dashboards.
        // Bridge-mode dashboards (mobile WebView) render + print on the
        // tablet's Bluetooth printer directly. They need the rendered
        // payload + copies count to produce a receipt identical to the
        // print-bridge desktop output. We strip brandLogoUrl out of the
        // event because base64 PNGs can be 50KB+ and the bridge can't
        // raster them in JS for ESC/POS anyway — print-bridge's logo
        // pathway uses canvas which isn't viable in the WebView.
        const liteForBridge = (() => {
          const p = (t.payload ?? {}) as Record<string, any>;
          const { brandLogoUrl, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
          return rest;
        })();
        this.socket.emitToLocation(
          order.locationId,
          "printer:job:created" as any,
          {
            id: row.id,
            type: row.type,
            printerId: row.printerId,
            stationId: row.stationId,
            status: row.status,
            locationId: order.locationId,
            orderId: dto.orderId,
            trigger: dto.trigger,
            copies: row.copies,
            payload: liteForBridge,
          } as any,
        );
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

  // ── Table Tabs — round chit ─────────────────────────────────────────
  //
  // A dine-in tab round appends items to the existing order. The kitchen
  // paper trail must show ONLY the new lines (the KDS already resyncs with
  // per-item state) — re-firing the whole ticket would double-cook round 1.
  // Routes the round's items through the normal station routing (drinks →
  // bar printer, food → kitchen) with a bold "ROUND N — NEW ITEMS ONLY"
  // note, kitchen tickets only (never the customer receipt).

  async createRoundChit(args: {
    orderId: string;
    roundNumber: number;
    items: {
      name: string;
      quantity: number;
      modifiers?: { name: string; quantity?: number; price?: number }[];
      notes?: string | null;
    }[];
  }): Promise<string[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: args.orderId },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (!order || !order.locationId) {
      throw new NotFoundException("Order not found");
    }

    const targets = await this.routing.resolveForOrder(args.orderId, {
      trigger: "ORDER_ACCEPTED",
      kitchenOnly: true,
      itemsOverride: args.items,
      chitNote: `ROUND ${args.roundNumber} — NEW ITEMS ONLY`,
    });
    if (!targets.length) {
      this.logger.warn(
        `Round chit for order ${args.orderId} (round ${args.roundNumber}): no print targets resolved — check that a kitchen station or the location has a printer`,
      );
      return [];
    }

    // NOTE: autoPrintRules are deliberately NOT applied here. Those rules
    // gate *automatic* fan-out on status triggers; a round chit is an
    // explicit operator action ("Send round to kitchen") and must reach the
    // kitchen the same way the first ticket did — a shop whose printer has
    // no ORDER_ACCEPTED rule would otherwise silently print nothing.
    const created: string[] = [];
    for (const t of targets) {
      const idempotencyKey = `order:${args.orderId}:round:${args.roundNumber}:${t.stationId ?? "-"}`;
      try {
        const row = await (this.prisma as any).printJob.create({
          data: {
            tenantId: order.tenantId,
            locationId: order.locationId,
            orderId: args.orderId,
            printerId: t.printerId,
            stationId: t.stationId,
            type: t.type,
            status: "QUEUED",
            payload: t.payload,
            copies: t.copies,
            trigger: "ORDER_ACCEPTED",
            routeKey: t.routeKey,
            idempotencyKey,
          },
        });
        created.push(row.id);
        // Same bridge-dashboard notification as createFromOrder — tablet
        // bridges render + print from this event.
        const liteForBridge = (() => {
          const p = (t.payload ?? {}) as Record<string, any>;
          const { brandLogoUrl, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
          return rest;
        })();
        this.socket.emitToLocation(
          order.locationId,
          "printer:job:created" as any,
          {
            id: row.id,
            type: row.type,
            printerId: row.printerId,
            stationId: row.stationId,
            status: row.status,
            locationId: order.locationId,
            orderId: args.orderId,
            trigger: "ORDER_ACCEPTED",
            copies: row.copies,
            payload: liteForBridge,
          } as any,
        );
      } catch (err: any) {
        // Idempotent replay (double-tap of Send) — reuse the existing row.
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
      `Round chit created for order ${args.orderId} (round ${args.roundNumber}): ${created.length} job(s)`,
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
    const updated = await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: { status: "PRINTING" },
    });
    this.emitUpdated(updated);
    return updated;
  }

  // Bridge-mode completion. The tablet's WebView renders + writes the
  // receipt over Bluetooth itself (no agent claim/poll cycle), so it
  // can't use the agent-protocol :id/complete endpoint. This marks the
  // job PRINTED off the back of a normal authenticated dashboard
  // session — we only verify the job belongs to the caller's tenant.
  // Idempotent: re-marking an already-PRINTED job is a no-op.
  async markPrintedByBridge(jobId: string, tenantId: string) {
    const job = await (this.prisma as any).printJob.findUnique({
      where: { id: jobId },
      select: { id: true, tenantId: true, status: true },
    });
    if (!job) throw new NotFoundException("Job not found");
    if (job.tenantId !== tenantId) {
      throw new BadRequestException("Job belongs to another tenant");
    }
    if (job.status === "PRINTED") return job;
    const updated = await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: {
        status: "PRINTED",
        printedAt: new Date(),
        nextRetryAt: null,
        deadLetteredAt: null,
      },
    });
    this.emitUpdated(updated);
    return updated;
  }

  // Bridge polling fallback. The tablet WebView polls this every few
  // seconds and prints any QUEUED job over Bluetooth, then marks it
  // PRINTED via markPrintedByBridge. This is the safety net for when
  // the printer:job:created socket event doesn't reach the WebView
  // (backgrounded tab, dropped socket, etc.) — without it, auto-print
  // silently never fires and jobs pile up in QUEUED. We only return
  // recent jobs (last 15 min) so a backlog of old stuck jobs can't
  // trigger a paper avalanche, and strip the heavy base64 logo the
  // bridge can't rasterise anyway.
  async pendingBridgeJobs(tenantId: string, locationId?: string) {
    const since = new Date(Date.now() - 15 * 60_000);
    const rows = await (this.prisma as any).printJob.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        status: "QUEUED",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "asc" },
      take: 15,
      select: {
        id: true,
        printerId: true,
        type: true,
        copies: true,
        trigger: true,
        payload: true,
      },
    });
    return rows.map((r: any) => {
      const p = (r.payload ?? {}) as Record<string, any>;
      const { brandLogoUrl, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
      return { ...r, payload: rest };
    });
  }

  // Clear the queue: cancel every still-pending job for the tenant
  // (optionally one location). Used by the "Clear queue" button so the
  // operator can wipe a backlog of stuck/old jobs in one tap.
  async clearQueue(tenantId: string, locationId?: string) {
    // PrintJobStatus has no CANCELLED — FAILED is the terminal "won't
    // print" state. Dead-letter them so they leave the active queue and
    // don't get retried.
    const { count } = await (this.prisma as any).printJob.updateMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        status: { in: ["QUEUED", "CLAIMED", "PRINTING", "RETRYING"] },
      },
      data: {
        status: "FAILED",
        error: "Cleared from queue by operator",
        nextRetryAt: null,
        deadLetteredAt: new Date(),
      },
    });
    return { cleared: count };
  }

  // Mark every pending job for an order PRINTED. The tablet now prints
  // receipts itself (client-side Bluetooth), so the server-created
  // PrintJob would otherwise sit QUEUED forever and "last print" would
  // never update. The WebView calls this after it prints an order so the
  // queue clears and the widgets reflect reality. Returns how many it
  // flipped + emits so the dashboard refreshes live.
  async markOrderPrinted(orderId: string, tenantId: string) {
    const jobs = await (this.prisma as any).printJob.findMany({
      where: {
        orderId,
        tenantId,
        status: { in: ["QUEUED", "CLAIMED", "PRINTING", "RETRYING"] },
      },
      select: { id: true },
    });
    const now = new Date();
    for (const j of jobs) {
      const updated = await (this.prisma as any).printJob.update({
        where: { id: j.id },
        data: { status: "PRINTED", printedAt: now, nextRetryAt: null },
      });
      this.emitUpdated(updated);
    }
    // Log the successful print into the operator activity feed.
    const order = await (this.prisma as any).order.findFirst({
      where: { id: orderId, tenantId },
      select: { displayId: true, orderNumber: true, locationId: true, brandId: true },
    });
    const label = order?.displayId ?? order?.orderNumber ?? orderId.slice(-5);
    this.logPrint({
      tenantId,
      locationId: order?.locationId ?? null,
      brandId: order?.brandId ?? null,
      status: "SUCCESS",
      action: "print.receipt",
      message: `Receipt printed for order #${label}`,
      details: { orderId, jobsCleared: jobs.length },
    });
    return { printed: jobs.length };
  }

  // Client-reported print outcome → Logs feed. The tablet prints client-side,
  // so the server can't see failures or test prints; the web app posts them
  // here. Success order prints are already logged by markOrderPrinted.
  async recordPrintReport(dto: PrintReportDto, tenantId: string) {
    let locationId: string | null = null;
    let brandId: string | null = null;
    let displayId = dto.displayId ?? null;
    if (dto.orderId) {
      const order = await (this.prisma as any).order.findFirst({
        where: { id: dto.orderId, tenantId },
        select: { displayId: true, orderNumber: true, locationId: true, brandId: true },
      });
      if (order) {
        locationId = order.locationId ?? null;
        brandId = order.brandId ?? null;
        displayId = displayId ?? order.displayId ?? order.orderNumber ?? null;
      }
    }
    const kind = dto.kind ?? "order";
    const who = dto.printerName ? ` (${dto.printerName})` : "";
    const orderRef = displayId ? ` for order #${displayId}` : "";
    const message = dto.ok
      ? kind === "test"
        ? `Test print sent${who}`
        : `Receipt printed${orderRef}${who}`
      : `Print failed${orderRef}${who}: ${dto.message ?? "unknown error"}`;
    this.logPrint({
      tenantId,
      locationId,
      brandId,
      status: dto.ok ? (kind === "test" ? "INFO" : "SUCCESS") : "ERROR",
      action: kind === "test" ? "print.test" : "print.receipt",
      message,
      details: {
        orderId: dto.orderId ?? null,
        printerName: dto.printerName ?? null,
        error: dto.ok ? undefined : dto.message,
        kind,
      },
    });
    return { ok: true };
  }

  async markPrinted(jobId: string, agentId: string) {
    const job = await this.requireClaimedBy(jobId, agentId);
    const updated = await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: {
        status: "PRINTED",
        printedAt: new Date(),
        nextRetryAt: null,
        deadLetteredAt: null,
      },
    });
    this.emitUpdated(updated);
    return updated;
  }

  // Phase AS-2 — retry + dead-letter aware. retryable=false short-
  // circuits straight to FAILED + dead-letter (no point hammering a
  // bad payload). retryable=true escalates: attempts++ and either
  // schedules nextRetryAt with exponential backoff (≤ maxRetries) or
  // dead-letters. failureReason is the short tag the dashboard
  // filters by (printer_offline / network / bad_payload / ...);
  // lastError is the verbose detail.
  async markFailed(
    jobId: string,
    agentId: string,
    args: { failureReason: string; lastError: string; retryable: boolean },
  ) {
    const job = await this.requireClaimedBy(jobId, agentId);
    const attempts = (job.attempts ?? 0) + 1;
    const max = job.maxRetries ?? 3;
    const willRetry = args.retryable && attempts < max;

    const updated = await (this.prisma as any).printJob.update({
      where: { id: jobId },
      data: {
        attempts,
        failureReason: args.failureReason,
        lastError: args.lastError,
        // Keep `error` populated for backwards-compat with the legacy
        // dashboards that read that column.
        error: args.lastError,
        status: willRetry ? "RETRYING" : "FAILED",
        nextRetryAt: willRetry
          ? new Date(Date.now() + this.backoffMs(attempts))
          : null,
        deadLetteredAt: willRetry ? null : new Date(),
        claimedByAgentId: null,
        claimedAt: null,
      },
    });
    this.emitUpdated(updated);
    if (!willRetry) {
      this.logger.warn(
        `PrintJob ${jobId} dead-lettered after ${attempts} attempts: ${args.failureReason}`,
      );
    }
    return updated;
  }

  // Cron-friendly: flips RETRYING rows whose nextRetryAt has elapsed
  // back to QUEUED so an agent can re-claim. Called from the same
  // 30-second cron that runs releaseStaleClaims().
  async promoteRetries() {
    const now = new Date();
    const { count } = await (this.prisma as any).printJob.updateMany({
      where: {
        status: "RETRYING",
        nextRetryAt: { lte: now },
      },
      data: {
        status: "QUEUED",
        nextRetryAt: null,
      },
    });
    return { promoted: count };
  }

  // 1s, 4s, 9s, 16s … capped at 60s. Reasonable for a temporary
  // network blip; long enough that a sick printer doesn't burn the
  // attempts budget in the first second after going offline.
  private backoffMs(attempt: number): number {
    return Math.min(60_000, 1000 * attempt * attempt);
  }

  // ── Reaper ──────────────────────────────────────────────────────────
  //
  // Cron-callable. Re-queues jobs that an agent claimed but never
  // completed (process crashed mid-print). 60s window matches a 15s
  // heartbeat × 4 missed beats.

  // Phase AS-4 — dashboard widgets.
  async widgets(tenantId: string, locationId?: string) {
    const baseWhere: any = {
      tenantId,
      ...(locationId && { locationId }),
    };
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [printers, queueDepth, failedJobs, lastPrint] = await Promise.all([
      (this.prisma as any).printer.findMany({
        where: { tenantId, ...(locationId && { locationId }) },
        select: { isOnline: true },
      }),
      (this.prisma as any).printJob.count({
        where: { ...baseWhere, status: { in: ["QUEUED", "CLAIMED"] } },
      }),
      (this.prisma as any).printJob.count({
        where: { ...baseWhere, status: "FAILED", createdAt: { gte: dayAgo } },
      }),
      (this.prisma as any).printJob.findFirst({
        where: { ...baseWhere, status: "PRINTED" },
        orderBy: { printedAt: "desc" },
        select: { printedAt: true },
      }),
    ]);
    return {
      online: printers.filter((p: any) => p.isOnline).length,
      offline: printers.filter((p: any) => !p.isOnline).length,
      queueDepth,
      failedLast24h: failedJobs,
      lastPrintedAt: lastPrint?.printedAt ?? null,
    };
  }

  // Phase AS-4 — print job history (for the dashboard's "Recent
  // activity" panel and per-printer logs).
  async list(args: {
    tenantId: string;
    locationId?: string;
    status?: string;
    limit?: number;
  }) {
    return (this.prisma as any).printJob.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.locationId && { locationId: args.locationId }),
        ...(args.status && { status: args.status }),
      },
      orderBy: { createdAt: "desc" },
      take: args.limit ?? 50,
      select: {
        id: true,
        type: true,
        status: true,
        printerId: true,
        stationId: true,
        copies: true,
        attempts: true,
        error: true,
        createdAt: true,
        printedAt: true,
      },
    });
  }

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

  private isScheduledForFuture(o: {
    scheduledFor?: Date | null;
    scheduledAt?: Date | null;
  }): boolean {
    const when = o.scheduledFor ?? o.scheduledAt;
    if (!when) return false;
    return new Date(when).getTime() > Date.now() + 5 * 60_000; // 5min grace
  }

  // Filter targets down to the printers actually wired to print on
  // this trigger. Receipt / driver-slip targets pass through
  // unconditionally because there's only ever one "natural" trigger
  // for them and the operator has already opted in by configuring
  // Location.receiptPrinterId / dispatchPrinterId.
  private async filterTargetsByAutoRules(
    targets: PrintTarget[],
    trigger: string,
  ): Promise<PrintTarget[]> {
    const kitchenIds = new Set<string>();
    for (const t of targets) {
      if (t.type === "KITCHEN_TICKET" && t.printerId)
        kitchenIds.add(t.printerId);
    }
    if (!kitchenIds.size) return targets;

    const printers = await (this.prisma as any).printer.findMany({
      where: { id: { in: Array.from(kitchenIds) } },
      select: { id: true, autoPrintRules: true },
    });
    const ruleByPrinter = new Map(
      printers.map((p: any) => [p.id, p.autoPrintRules]),
    );

    return targets.flatMap((t) => {
      if (t.type !== "KITCHEN_TICKET") return [t]; // receipts/dispatch pass
      if (!t.printerId) return [t]; // unrouted — let it through if includeUnrouted on
      const rule = this.matchAutoRule(
        ruleByPrinter.get(t.printerId),
        trigger,
      );
      if (!rule.matches) return [];
      return [{ ...t, copies: rule.copies }];
    });
  }

  private emitUpdated(job: any) {
    if (!job?.locationId) return;
    this.socket.emitToLocation(
      job.locationId,
      "printer:job:updated" as any,
      {
        id: job.id,
        status: job.status,
        printerId: job.printerId,
        stationId: job.stationId,
        attempts: job.attempts,
        failureReason: job.failureReason,
        deadLetteredAt: job.deadLetteredAt,
      } as any,
    );
  }

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

// TEMP DEBUG helper — drops verbose fields (items array, full address
// blobs) and limits everything else so the log line stays readable.
// Remove when receipt content is confirmed correct.
function scrubPayloadForLog(p: any): any {
  if (!p || typeof p !== "object") return p;
  const out: any = {};
  for (const k of Object.keys(p)) {
    const v = (p as any)[k];
    if (k === "items" && Array.isArray(v)) {
      out.items = `[${v.length} items]`;
    } else if (typeof v === "string" && v.length > 80) {
      out[k] = v.slice(0, 80) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}
