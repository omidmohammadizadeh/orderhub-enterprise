import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { DeliverooClientService } from "./deliveroo-client.service";
import { mapDeliverooOrderStatus } from "./deliveroo-order.mappers";

// ── Closing Deliveroo platform-delivery orders ──────────────────────────────
//
// WHY THIS EXISTS
//
// Deliveroo never tells the merchant a rider delivered. Confirmed against
// production orders #5049 and #5116 — 40 `rider.status_update` events, zero
// `rider_delivered`. The merchant-side rider log runs
//
//   rider_assigned → rider_arrived → rider_confirmed_at_restaurant →
//   rider_unassigned
//
// and then repeats unchanged with lat/lon pinned to 0,0 until the events
// stop: Deliveroo cuts the restaurant's view of the rider at pickup. The
// `order.status_update` webhook doesn't fill the gap either — only two fire
// per order, both within two seconds of `order.new`.
//
// So a platform-delivery order can only be closed by ASKING. This cron polls
// `GET /order/v1/orders/{id}` for in-flight orders and applies the terminal
// answer. Nothing else here changes: the webhooks still own every
// intermediate stage, and this only ever writes COMPLETED / CANCELLED /
// REJECTED / FAILED.
//
// DELIBERATE LIMITS — this runs against a live POS:
//
//  - TERMINAL ONLY. Polling intermediate stages would race the webhooks for
//    the same transitions and produce two sources of truth for the board.
//  - PLATFORM COURIER ONLY. Merchant-fleet deliveries are driven by our own
//    dispatch, and Deliveroo has no view of them to report.
//  - AGE-BOUNDED. Past MAX_AGE_HOURS we stop asking; the 05:00 rollover
//    (OrdersAutoCompleteCron) is the existing backstop and still applies.
//  - KILLABLE WITHOUT A DEPLOY. DELIVEROO_ORDER_POLL_ENABLED=false stops it.
//
// The response shape is probed rather than assumed. Deliveroo's field naming
// has drifted across API versions and the docs have been wrong three times
// now (see [[feedback-external-api-shape-first]]), so a payload we can't read
// logs its own top-level keys — one deploy then tells us the real field
// instead of another guess.

/** Statuses a Deliveroo order can still legitimately move on from. */
const IN_FLIGHT: readonly string[] = [
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PENDING_DISPATCH",
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
  "RIDER_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DISPATCHED",
];

/** The only statuses this poller is allowed to write. */
const TERMINAL = new Set(["COMPLETED", "CANCELLED", "REJECTED", "FAILED"]);

const MAX_AGE_HOURS = 6;
/** Orders examined per tick. A very busy Friday is nowhere near this. */
const BATCH_LIMIT = 60;
/** Simultaneous calls to Deliveroo. Their order API is not documented as
 *  rate-limited the way menu upload is (1/min/site), so stay modest. */
const CONCURRENCY = 4;

@Injectable()
export class DeliverooOrderPollService {
  private readonly logger = new Logger(DeliverooOrderPollService.name);
  /** Guards against a slow tick overlapping the next one. */
  private running = false;
  /** Orders whose payload we couldn't read, so the warning fires once rather
   *  than every two minutes for the whole six-hour window. */
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly client: DeliverooClientService,
  ) {}

  private get enabled(): boolean {
    // Namespaced like every other platform setting — a raw process.env read
    // wouldn't survive the ConfigModule `validate` step.
    const flag = this.config.get<boolean>(
      "app.platforms.deliveroo.orderPollEnabled",
    );
    if (flag === false) return false;
    return this.client.configured;
  }

  @Cron("*/2 * * * *")
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) {
      this.logger.warn("Deliveroo poll: previous tick still running — skipping");
      return;
    }
    this.running = true;
    try {
      await this.pollOnce();
    } catch (err: any) {
      this.logger.error(`Deliveroo poll tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests and for a manual kick from the admin tooling. */
  async pollOnce(): Promise<{ checked: number; closed: number }> {
    const since = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);

    const rows = await this.prisma.order.findMany({
      where: {
        platform: "DELIVEROO",
        integrationSource: "DIRECT",
        viaHubrise: false,
        externalId: { not: null },
        status: { in: IN_FLIGHT as any },
        createdAt: { gte: since },
        // Platform courier only. `deliveryType` is the field the inbound
        // webhook sets ("PLATFORM"); fulfillmentType is checked too because
        // older rows predate it.
        OR: [
          { deliveryType: "PLATFORM" },
          { fulfillmentType: "PLATFORM_COURIER" as any },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        externalId: true,
        status: true,
        displayId: true,
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_LIMIT,
    });

    if (rows.length === 0) return { checked: 0, closed: 0 };

    let closed = 0;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        const row = rows[idx];
        if (!row) return;
        if (await this.closeIfFinished(row)) closed++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
    );

    // Always say what a tick did. Every Deliveroo bug this integration has
    // had was invisible because a code path decided nothing and said nothing.
    this.logger.log(
      `Deliveroo poll: checked ${rows.length} in-flight order(s), closed ${closed}`,
    );
    return { checked: rows.length, closed };
  }

  private async closeIfFinished(row: {
    id: string;
    tenantId: string;
    externalId: string | null;
    status: string;
    displayId: string | null;
  }): Promise<boolean> {
    const externalId = row.externalId!;
    const label = row.displayId ? `#${row.displayId}` : row.id;

    let payload: any;
    try {
      payload = await this.client.request(
        "GET",
        `/order/v1/orders/${encodeURIComponent(externalId)}`,
      );
    } catch (err: any) {
      // Best-effort by design: a 404/5xx must never take the tick down. The
      // age bound stops us asking about a lost order forever.
      this.logger.warn(
        `Deliveroo poll ${label} (${externalId}): lookup failed — ${err?.message ?? err}`,
      );
      return false;
    }

    const statuses = this.statusesFrom(payload);
    const sync = this.syncSummary(payload);

    if (statuses.length === 0) {
      // Don't guess the field — show what actually came back so one deploy
      // fixes it. Docs have been wrong three times on this integration.
      // ONCE per order: this used to warn every 2 minutes for six hours.
      if (!this.unreadable.has(row.id)) {
        this.unreadable.add(row.id);
        const sample = (payload?.order_events ?? [])[0];
        this.logger.warn(
          `Deliveroo poll ${label}: no status in response — keys: ` +
            `${Object.keys(payload ?? {}).join(", ") || "(none)"}` +
            (sample
              ? ` | first order_event: ${JSON.stringify(sample).slice(0, 300)}`
              : " | order_events is empty"),
        );
      }
      return false;
    }

    // The furthest terminal status anywhere in the trail, not the last entry
    // — ordering is Deliveroo's business and a terminal event that isn't last
    // must still close the order.
    let mapped: string | null = null;
    for (const s of statuses) {
      const m = mapDeliverooOrderStatus(s);
      if (m && TERMINAL.has(m)) {
        mapped = m;
        break;
      }
    }

    if (!mapped) {
      this.logger.log(
        `Deliveroo poll ${label}: ${statuses.join(" → ")} — nothing terminal, ` +
          `leaving alone | ${sync}`,
      );
      return false;
    }
    if (mapped === row.status) return false;

    try {
      await this.orders.updateStatus(
        row.id,
        row.tenantId,
        { status: mapped as any } as any,
        "deliveroo-poll",
        // WEBHOOK, not SYSTEM: this fact CAME from Deliveroo, so the outbound
        // sync must not echo it back as a status push (it would just 409).
        "WEBHOOK",
      );
      this.logger.log(
        `Deliveroo poll ${label}: ${statuses.join(" → ")} ⇒ ${mapped} ` +
          `(was ${row.status}) | ${sync}`,
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Deliveroo poll ${label}: ${row.status} → ${mapped} rejected — ${err?.message ?? err}`,
      );
      return false;
    }
  }

  /**
   * The statuses Deliveroo reports for an order.
   *
   * CONFIRMED from production (2026-08-17): `GET /order/v1/orders/{id}` does
   * NOT return an order object with a status on it. It returns an AUDIT
   * TRAIL:
   *
   *   { order_id, created_at, order_events[], order_sync_statuses[],
   *     order_prep_stages[] }
   *
   * The lifecycle lives in `order_events[]`. We return every status in it
   * rather than just the last, for the same reason furthestRiderStage reads
   * the whole rider log: ordering is Deliveroo's business, not ours, and a
   * terminal event that isn't last must still count. The caller only ever
   * acts on terminal statuses, so scanning all of them is safe.
   *
   * Field names inside an event are still probed — that layer is unverified,
   * and unreadableShape() logs a real sample if none match.
   */
  private statusesFrom(payload: any): string[] {
    const events = Array.isArray(payload?.order_events) ? payload.order_events : [];
    const out: string[] = [];
    for (const e of events) {
      const s =
        e?.status ?? e?.event ?? e?.event_type ?? e?.type ?? e?.name ?? e?.state;
      if (typeof s === "string" && s.trim()) out.push(s.trim());
    }
    if (out.length) return out;

    // Older/simpler shapes, kept so a future API change doesn't strand us.
    for (const c of [
      payload?.status,
      payload?.order?.status,
      payload?.body?.order?.status,
      payload?.data?.status,
      payload?.order_status,
    ]) {
      if (typeof c === "string" && c.trim()) return [c.trim()];
    }
    return [];
  }

  /**
   * What Deliveroo thinks of our sync_status calls, from the same response.
   *
   * The partner dashboard's "Injection Success Rate" is the ratio of orders
   * for which Deliveroo received a successful sync_status — and ours reads
   * 0%. This array is their record of those calls, so the poll we already
   * make answers it for free. Logged, never acted on.
   */
  private syncSummary(payload: any): string {
    const syncs = Array.isArray(payload?.order_sync_statuses)
      ? payload.order_sync_statuses
      : [];
    if (!syncs.length) return "sync_statuses=NONE (Deliveroo has no record)";
    const seen = syncs
      .map((s: any) => s?.status ?? s?.state ?? s?.result ?? "?")
      .join(",");
    return `sync_statuses=${syncs.length} [${seen}]`;
  }
}
