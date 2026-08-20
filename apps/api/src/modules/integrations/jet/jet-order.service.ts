import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetOrderAckService } from "./jet-order-ack.service";
import { transformJetOrder } from "./jet-order.transformer";
import {
  classifyJetFailure,
  jetOrderIdFrom,
  jetPosLocationIdFrom,
} from "./jet-order.mappers";

// Phase JE-1 — JET Connect order intake.
//
// The webhook controller has already verified the request, persisted the raw
// envelope and answered 202. This is where a received order becomes a real one
// on the board, and where JET gets told what happened.
//
// The whole method is written so that EVERY exit path acknowledges. An order
// we never answer for is worse than one we explicitly fail: the failure routes
// to the restaurant's backup flow, the silence just expires. So the outer
// try/catch acks a classified failure and the ack service's watchdog covers
// even a process death.

export interface JetIntakeResult {
  handled: boolean;
  reason?: string;
  orderId?: string;
}

@Injectable()
export class JetOrderService {
  private readonly logger = new Logger(JetOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly ack: JetOrderAckService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Handle one Receive Order / Final Picked Order payload.
   *
   * `transmissionId` distinguishes the initial injection from the final picked
   * copy for partners on the multi-injection flow; JET requires it echoed back
   * on the ack when present.
   */
  async ingestOrder(
    payload: any,
    opts: { kind: "initial" | "final"; transmissionId?: string | null } = {
      kind: "initial",
    },
  ): Promise<JetIntakeResult> {
    const jetOrderId = jetOrderIdFrom(payload);
    if (!jetOrderId) {
      // Nothing to ack against — JET's own id is the only handle we get.
      this.logger.error(
        `JET ${opts.kind} order has no id (keys=${Object.keys(payload ?? {}).join(",")}) — cannot ingest or acknowledge`,
      );
      return { handled: false, reason: "no_order_id" };
    }

    const transmissionId =
      opts.transmissionId ?? payload?.transmissionId ?? payload?.transmission_id ?? null;

    try {
      // ── Route to a restaurant ─────────────────────────────────────────
      const { value: posLocationId, field } = jetPosLocationIdFrom(payload);
      if (!posLocationId) {
        throw new Error(
          "The order carried no posLocationId, so it could not be routed to a restaurant",
        );
      }
      if (field !== "posLocationId") {
        // Falling back to JET's own location id means posLocationId was never
        // configured on their side — the exact thing INCORRECT_SETUP is for.
        this.logger.warn(
          `JET order ${jetOrderId}: no posLocationId, routed on ${field} instead — ` +
            `ask JET to set the POS location id for this restaurant`,
        );
      }

      const conn = await this.resolveConnection(posLocationId);
      if (!conn) {
        throw new Error(
          `No connected Just Eat restaurant for posLocationId "${posLocationId}"`,
        );
      }

      // Now that we know the tenant, upgrade the pending-ack record so the
      // watchdog can attribute a timeout to the right brand.
      await this.ack.markPending({
        jetOrderId,
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        transmissionId,
      });

      // ── Normalise ─────────────────────────────────────────────────────
      const transformed = transformJetOrder(payload);
      if (!transformed) throw new Error("Order payload could not be normalised");
      const { canonical, warnings } = transformed;
      for (const w of warnings) {
        this.logger.warn(`JET order ${jetOrderId}: ${w}`);
      }

      // A direct integration knows its brand from the connection — no name
      // hint, no guessing, and none of the duplicate-brand resolution the
      // HubRise path needs.
      (canonical as any).brandId = conn.brandId ?? undefined;
      (canonical as any).deliveryType =
        (canonical.metadata as any)?.deliveryType ?? undefined;

      // ── The final-picked copy amends an order we already have ─────────
      //
      // ingestCanonical is create-only: it returns the existing row untouched
      // on a repeat, which is exactly right for a redelivery and exactly wrong
      // for the final picked order, whose whole purpose is that items and
      // totals may have CHANGED. resyncMarketplaceItems is the same path the
      // Uber customer-update flow uses.
      if (opts.kind === "final") {
        const existing = await this.prisma.order.findFirst({
          where: { externalId: jetOrderId, platform: "JUST_EAT" },
          select: { id: true },
        });
        if (existing) {
          await this.orders.resyncMarketplaceItems(
            jetOrderId,
            "JUST_EAT",
            conn.tenantId,
            canonical,
          );
          this.logger.log(
            `JET final picked order ${jetOrderId} → resynced order ${existing.id}`,
          );
          await this.ack.ackSuccess({
            jetOrderId,
            tenantId: conn.tenantId,
            brandId: conn.brandId,
            locationId: conn.locationId,
            orderId: existing.id,
            transmissionId,
          });
          return { handled: true, orderId: existing.id };
        }
        // No prior order — the final copy is all we have, so ingest it as new
        // rather than dropping it.
        this.logger.warn(
          `JET final picked order ${jetOrderId} has no initial order — ingesting it as new`,
        );
      }

      // ── Ingest ────────────────────────────────────────────────────────
      const created = await this.orders.ingestCanonical(
        canonical,
        conn.tenantId,
        conn.locationId,
      );

      // Courier details ride in on the order itself for partner deliveries.
      await this.writeCourierFields(created.id, canonical);

      this.logger.log(
        `JET ${opts.kind} order ${jetOrderId} (ref ${canonical.displayId}) → order ${created.id} ` +
          `at ${posLocationId} — ${canonical.items.length} line(s), total ${canonical.total}`,
      );

      await this.ack.ackSuccess({
        jetOrderId,
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        orderId: created.id,
        transmissionId,
      });

      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "JUST_EAT",
        action: "order.received",
        status: "SUCCESS",
        message: `Just Eat order ${canonical.displayId} received`,
        details: {
          jetOrderId,
          items: canonical.items.length,
          total: canonical.total,
          type: payload?.type ?? null,
          ...(warnings.length ? { warnings } : {}),
        },
      });

      return { handled: true, orderId: created.id };
    } catch (err: any) {
      const { code, message } = classifyJetFailure(err);
      this.logger.error(
        `JET ${opts.kind} order ${jetOrderId} failed to ingest (${code}): ${err?.message}`,
      );
      // Tell JET explicitly. This routes the order to the backup flow rather
      // than letting it expire, and the code tells the operator what to fix.
      await this.ack.ackFailure({
        jetOrderId,
        code,
        message,
        transmissionId,
      });
      return { handled: false, reason: `ingest_failed:${code}` };
    }
  }

  /**
   * Find the connected restaurant for a posLocationId.
   *
   * `externalStoreId` is the field the connect flow writes the POS location id
   * to, so it is checked first. The metadata fallback covers a connection
   * whose JET-side id differs from the store id we registered — it is worth a
   * lookup rather than rejecting an otherwise-valid order.
   */
  private async resolveConnection(posLocationId: string): Promise<{
    tenantId: string;
    brandId: string | null;
    locationId: string;
  } | null> {
    const select = { tenantId: true, brandId: true, locationId: true } as const;
    const byStoreId = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "JUST_EAT",
        externalStoreId: posLocationId,
        status: { not: "not_connected" },
      },
      select,
    });
    if (byStoreId) return byStoreId;

    return this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "JUST_EAT",
        status: { not: "not_connected" },
        metadata: { path: ["posLocationId"], equals: posLocationId },
      },
      select,
    });
  }

  /**
   * Copy the driver details JET sent with the order onto the courier columns.
   *
   * Partner-delivery orders arrive with the driver already assigned, so the
   * board can show who is collecting before the first driver-status webhook
   * lands. Written directly rather than through the canonical order because
   * these are flat columns on Order, not part of CanonicalOrder. Best-effort:
   * a failure here must not turn a successful ingest into a failed ack.
   */
  private async writeCourierFields(
    orderId: string,
    canonical: { metadata: Record<string, unknown> },
  ): Promise<void> {
    const courier = (canonical.metadata as any)?.courier;
    if (!courier?.name && !courier?.phone) return;
    try {
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          ...(courier.name ? { courierName: courier.name } : {}),
          ...(courier.phone ? { courierPhone: courier.phone } : {}),
          ...(courier.phoneAccessCode
            ? { courierPhoneAccessCode: courier.phoneAccessCode }
            : {}),
        } as any,
      });
    } catch (e: any) {
      this.logger.warn(
        `JET order ${orderId}: could not write courier fields: ${e?.message}`,
      );
    }
  }
}
