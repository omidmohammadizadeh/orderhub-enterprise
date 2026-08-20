import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";
import type { JetFailureCode } from "./jet-order.mappers";

// Phase JE-1 — asynchronous order acknowledgement.
//
// THE CONTRACT, AND WHY THIS FILE IS ITS OWN SERVICE
//
// Answering JET's Receive Order webhook with 202 puts the order in a PENDING
// state on their side. We then have THREE MINUTES to call either
// /order/{id}/sent-to-pos-success or /order/{id}/sent-to-pos-failed. Miss the
// window and JET marks the order "failed to inject" — which counts against the
// 99.5% order-injection SLA *and*, unlike an explicit failure, does not route
// the order into the restaurant's backup flow. A silent timeout is therefore
// strictly worse than an honest failure, and this service exists to make sure
// one never happens.
//
// Three mechanisms, in order of preference:
//   1. The intake path acks as soon as it knows the outcome (the normal case).
//   2. If intake throws, it acks FAILED with a classified error code, so the
//      order reaches the tablet backup flow with a reason attached.
//   3. If the process died between the 202 and either of those — a deploy
//      mid-order, an OOM, a hung DB call — the watchdog below force-acks
//      before the deadline. It runs every 30 seconds against a 90-second
//      threshold, leaving 90 seconds of margin inside JET's 3 minutes.
//
// Ack state lives on the WebhookEvent row (metadata.jetAck) rather than a new
// column: no migration, so no stale-Prisma-client risk on Render, and the row
// already exists for idempotency and raw-payload capture.

/** Ack lifecycle recorded on WebhookEvent.metadata.jetAck.state. */
export type JetAckState = "pending" | "success" | "failed";

/** How many times to retry an ack before giving up. Failing to ack is the
 *  worst outcome available, so this is deliberately generous. */
const ACK_RETRIES = 4;

@Injectable()
export class JetOrderAckService {
  private readonly logger = new Logger(JetOrderAckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: JetClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private cfg<T = string>(key: string): T {
    return this.config.get<T>(`app.platforms.jet.${key}`) as T;
  }

  /**
   * Record that we answered 202 and now owe JET an acknowledgement.
   * Idempotent: a redelivery must not reset an order we have already acked.
   */
  async markPending(args: {
    jetOrderId: string;
    tenantId?: string | null;
    locationId?: string | null;
    brandId?: string | null;
    transmissionId?: string | null;
  }): Promise<void> {
    await this.patchAck(args.jetOrderId, (existing) =>
      existing?.state && existing.state !== "pending"
        ? existing
        : {
            state: "pending" as JetAckState,
            pendingSince: existing?.pendingSince ?? new Date().toISOString(),
            tenantId: args.tenantId ?? existing?.tenantId ?? null,
            locationId: args.locationId ?? existing?.locationId ?? null,
            brandId: args.brandId ?? existing?.brandId ?? null,
            transmissionId: args.transmissionId ?? existing?.transmissionId ?? null,
          },
    );
  }

  /** Tell JET the order reached the POS. */
  async ackSuccess(args: {
    jetOrderId: string;
    tenantId?: string | null;
    brandId?: string | null;
    locationId?: string | null;
    orderId?: string | null;
    transmissionId?: string | null;
  }): Promise<boolean> {
    const body: Record<string, unknown> = {
      happenedAt: new Date().toISOString(),
    };
    // Only partners on the multi-injection flow send this, and JET rejects an
    // empty string, so it is omitted unless we actually received one.
    if (args.transmissionId) body.transmissionId = args.transmissionId;

    return this.send({
      ...args,
      path: `/order/${encodeURIComponent(args.jetOrderId)}/sent-to-pos-success`,
      body,
      state: "success",
      describe: "accepted",
    });
  }

  /**
   * Tell JET the order did NOT reach the POS, with a reason.
   *
   * This is not a rejection of the order — JET routes it into the backup flow
   * (typically the restaurant's tablet) so it still gets made. The error code
   * is what tells the operator whether to fix a store mapping, a PLU or their
   * opening hours, so classifyJetFailure earns its keep here.
   */
  async ackFailure(args: {
    jetOrderId: string;
    code: JetFailureCode;
    message: string;
    tenantId?: string | null;
    brandId?: string | null;
    locationId?: string | null;
    transmissionId?: string | null;
  }): Promise<boolean> {
    const body: Record<string, unknown> = {
      happenedAt: new Date().toISOString(),
      errorCode: args.code,
      // JET's schema requires a non-empty message; a blank one 400s the ack
      // and turns a handled failure into a timeout.
      errorMessage: args.message?.trim() || "Order could not be injected",
    };
    if (args.transmissionId) body.transmissionId = args.transmissionId;

    return this.send({
      ...args,
      path: `/order/${encodeURIComponent(args.jetOrderId)}/sent-to-pos-failed`,
      body,
      state: "failed",
      describe: `failed (${args.code})`,
    });
  }

  private async send(args: {
    jetOrderId: string;
    path: string;
    body: Record<string, unknown>;
    state: JetAckState;
    describe: string;
    tenantId?: string | null;
    brandId?: string | null;
    locationId?: string | null;
    orderId?: string | null;
    code?: JetFailureCode;
  }): Promise<boolean> {
    const started = Date.now();
    try {
      await this.client.request("POST", args.path, {
        keyType: "order",
        brandId: args.brandId,
        locationId: args.locationId,
        host: "orderStatus",
        body: args.body,
        retries: ACK_RETRIES,
      });
      const ms = Date.now() - started;
      await this.patchAck(args.jetOrderId, () => ({
        state: args.state,
        ackedAt: new Date().toISOString(),
        latencyMs: ms,
        ...(args.code ? { errorCode: args.code } : {}),
      }));
      this.logger.log(
        `JET ack ${args.describe} for order ${args.jetOrderId} in ${ms}ms`,
      );
      if (args.tenantId) {
        this.activity?.record({
          tenantId: args.tenantId,
          locationId: args.locationId ?? null,
          brandId: args.brandId ?? null,
          category: "ORDERS",
          channel: "JUST_EAT",
          action: `order.ack.${args.state}`,
          status: args.state === "success" ? "SUCCESS" : "WARNING",
          message: `Just Eat order ${args.jetOrderId} acknowledged as ${args.describe}`,
          details: { latencyMs: ms, ...args.body },
        });
      }
      return true;
    } catch (err: any) {
      // Every retry is spent. The order will time out on JET's side in a
      // couple of minutes; log loudly, because this is an SLA event and the
      // 30-minute incident clock effectively starts here.
      this.logger.error(
        `JET could NOT acknowledge order ${args.jetOrderId} as ${args.describe} ` +
          `after ${ACK_RETRIES + 1} attempts: ${err?.message}. JET will mark this ` +
          `order failed-to-inject in under 3 minutes.`,
      );
      await this.patchAck(args.jetOrderId, (existing) => ({
        ...(existing ?? {}),
        state: existing?.state === "pending" ? "pending" : existing?.state,
        lastAckError: String(err?.message ?? err).slice(0, 300),
        lastAckAttemptAt: new Date().toISOString(),
      }));
      if (args.tenantId) {
        this.activity?.record({
          tenantId: args.tenantId,
          locationId: args.locationId ?? null,
          brandId: args.brandId ?? null,
          category: "ORDERS",
          channel: "JUST_EAT",
          action: "order.ack.error",
          status: "ERROR",
          message:
            `Could not acknowledge Just Eat order ${args.jetOrderId} — ` +
            `it will be marked failed-to-inject`,
          details: { error: String(err?.message ?? err) },
        });
      }
      return false;
    }
  }

  /**
   * Read-modify-write of WebhookEvent.metadata.jetAck.
   *
   * Prisma has no partial-JSON update, so the whole metadata object is
   * rewritten. Best-effort throughout: bookkeeping must never be the reason an
   * order fails, and the watchdog is the backstop if a write is lost.
   */
  private async patchAck(
    jetOrderId: string,
    mutate: (existing: any) => any,
  ): Promise<void> {
    try {
      const row = await this.prisma.webhookEvent.findUnique({
        where: {
          platform_externalEventId: {
            platform: "JUST_EAT",
            externalEventId: jetOrderId,
          },
        },
        select: { metadata: true },
      });
      if (!row) return;
      const metadata = ((row.metadata as any) ?? {}) as Record<string, unknown>;
      const next = mutate((metadata as any).jetAck ?? null);
      await this.prisma.webhookEvent.update({
        where: {
          platform_externalEventId: {
            platform: "JUST_EAT",
            externalEventId: jetOrderId,
          },
        },
        data: { metadata: { ...metadata, jetAck: next } as any },
      });
    } catch (e: any) {
      this.logger.warn(
        `JET ack bookkeeping for ${jetOrderId} failed: ${e?.message}`,
      );
    }
  }

  // ── Watchdog ─────────────────────────────────────────────────────────

  /**
   * Force-ack orders that are still pending past the deadline.
   *
   * Runs every 30 seconds. Anything still pending after ackDeadlineSeconds
   * (90 by default) gets an explicit TIMEOUT failure, which reaches JET with
   * ~90 seconds to spare inside their 3-minute cutoff. That converts a silent
   * timeout — no backup flow, SLA hit — into a handled failure that still gets
   * the customer their food.
   *
   * Set JET_ACK_WATCHDOG_ENABLED=false to stop it without a deploy.
   */
  @Cron("*/30 * * * * *")
  async sweepPendingAcks(): Promise<void> {
    if (!this.cfg<boolean>("ackWatchdogEnabled")) return;
    if (!this.client.configured) return;

    const deadlineSeconds = Number(this.cfg("ackDeadlineSeconds")) || 90;
    const cutoff = new Date(Date.now() - deadlineSeconds * 1000);

    let rows: Array<{ externalEventId: string; metadata: any }> = [];
    try {
      rows = await this.prisma.webhookEvent.findMany({
        where: {
          platform: "JUST_EAT",
          receivedAt: { lt: cutoff },
          // Only orders we answered 202 to and have not resolved.
          metadata: { path: ["jetAck", "state"], equals: "pending" },
        },
        select: { externalEventId: true, metadata: true },
        // A burst of stuck orders is itself a symptom; cap the batch so one
        // sweep can't spend minutes inside a 30-second tick.
        take: 25,
        orderBy: { receivedAt: "asc" },
      });
    } catch (e: any) {
      this.logger.warn(`JET ack watchdog query failed: ${e?.message}`);
      return;
    }

    if (rows.length === 0) return;
    this.logger.warn(
      `JET ack watchdog: ${rows.length} order(s) still un-acked after ` +
        `${deadlineSeconds}s — sending explicit TIMEOUT failures`,
    );

    for (const row of rows) {
      const ack = ((row.metadata as any) ?? {}).jetAck ?? {};
      await this.ackFailure({
        jetOrderId: row.externalEventId,
        code: "TIMEOUT",
        message:
          "The order was received but the POS did not confirm it in time. " +
          "Sent to the backup flow.",
        tenantId: ack.tenantId ?? null,
        brandId: ack.brandId ?? null,
        locationId: ack.locationId ?? null,
        transmissionId: ack.transmissionId ?? null,
      });
    }
  }
}
