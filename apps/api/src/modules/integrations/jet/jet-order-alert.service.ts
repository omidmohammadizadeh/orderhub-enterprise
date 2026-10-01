import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ActivityLogService } from "../../logs/activity-log.service";
import { NotificationsService } from "../../notifications/notifications.service";

// An order Just Eat sent us that did not reach the kitchen.
//
// WHY THIS EXISTS. On 1 Oct 2026 a store rang to say an order had not come
// through. Every failure mode below already wrote a loud line to the Render
// log and a row to the Logs page — and nobody was watching either, so the
// customer was the monitoring. This service turns those three moments into
// something that reaches a person.
//
// THE THREE MOMENTS, worst last:
//   ingest_failed — we rejected the order and told JET why. The customer still
//                   gets fed: an explicit sent-to-pos-failed routes the order
//                   into the restaurant's own backup flow.
//   ack_failed    — we accepted the order but could not tell JET so. They will
//                   mark it failed-to-inject, which counts against the 99.5%
//                   injection SLA AND skips the backup flow.
//   abandoned     — past JET's three-minute window with no ack at all. Nothing
//                   more can be done for this order by anyone.
//
// TWO RULES THIS FILE MUST NEVER BREAK
//
// 1. RAISING AN ALERT CANNOT LOSE AN ORDER. Every path is caught and
//    swallowed, and callers invoke it AFTER the acknowledgement, never before.
//    An alerting bug that stopped us acking would cause the exact outage it is
//    meant to report.
// 2. IT MUST NOT SHOUT. The ack watchdog re-runs every 30 seconds against the
//    same stuck order, so without de-duplication one bad order would send an
//    email every half minute until it aged out.

export type JetAlertKind = "ingest_failed" | "ack_failed" | "abandoned";

export interface JetAlertArgs {
  kind: JetAlertKind;
  /** JET's own order id — the handle for every outbound call about it. */
  jetOrderId: string;
  /** third_party_order_reference: the number the shop and customer quote. */
  displayId?: string | null;
  tenantId?: string | null;
  brandId?: string | null;
  locationId?: string | null;
  restaurantName?: string | null;
  /** The JET failure code we acked with, when there was one. */
  code?: string | null;
  error?: string | null;
}

/** How long one order+kind stays quiet after alerting. Comfortably longer
 *  than JET's 3-minute window, so a stuck order alerts once and not 10x. */
const QUIET_MS = 60 * 60 * 1000;

@Injectable()
export class JetOrderAlertService {
  private readonly logger = new Logger(JetOrderAlertService.name);
  /** order+kind → when we last alerted. In memory on purpose: a restart
   *  re-alerting is harmless, a migration for this is not ([[prisma traps]]). */
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Report an order that did not make it to the kitchen.
   *
   * Resolves to undefined whatever happens — callers `void` it and move on.
   */
  async raise(args: JetAlertArgs): Promise<void> {
    try {
      if (this.seenRecently(args)) return;

      const ref = args.displayId || args.jetOrderId;
      const where = args.restaurantName || args.locationId || "an unmapped store";
      const detail = [args.code, args.error].filter(Boolean).join(" — ");

      // 1. The Logs page, always — it is the record even when nothing else
      //    is reachable, and it is scoped to the tenant that owns the order.
      if (args.tenantId) {
        this.activity?.record({
          tenantId: args.tenantId,
          locationId: args.locationId ?? null,
          brandId: args.brandId ?? null,
          category: "ORDERS",
          channel: "JUST_EAT",
          action: `order.alert.${args.kind}`,
          status: "ERROR",
          message: `${this.headline(args.kind)}: Just Eat order ${ref}`,
          details: { jetOrderId: args.jetOrderId, code: args.code, error: args.error },
        });
      }

      // 2. The shop. Phrased for someone standing at a till mid-service, not
      //    for whoever reads the stack trace later.
      if (args.locationId && args.tenantId) {
        await this.notifications
          ?.notifyLocation(
            args.locationId,
            args.tenantId,
            "INTEGRATION_FAILURE" as any,
            "Just Eat order not received",
            `Order ${ref} from Just Eat did not reach your till. ` +
              `Check the Just Eat tablet — you may need to take this one manually.`,
            { jetOrderId: args.jetOrderId, displayId: ref, kind: args.kind },
          )
          .catch((e: any) =>
            this.logger.warn(`JET alert: could not notify the shop: ${e?.message}`),
          );
      }

      // 3. Us. An unroutable order has no shop to tell, which makes the ops
      //    mail the ONLY signal — and the most urgent kind, because a store
      //    mapped wrong loses every order until someone fixes it.
      const opsEmail = String(
        this.config?.get<string>("app.platforms.jet.opsAlertEmail") ?? "",
      ).trim();
      if (opsEmail) {
        await this.notifications
          ?.sendOpsAlert(
            `${this.headline(args.kind)} — Just Eat order ${ref}`,
            `<p><b>${this.headline(args.kind)}</b></p>` +
              `<p>Store: ${where}<br/>` +
              `Order: ${ref} (JET id ${args.jetOrderId})<br/>` +
              `${detail ? `Reason: ${detail}<br/>` : ""}` +
              `When: ${new Date().toISOString()}</p>` +
              `<p>Search the API log for <code>${args.jetOrderId}</code> for the full trail.</p>`,
            opsEmail,
          )
          .catch((e: any) =>
            this.logger.warn(`JET alert: could not email ops: ${e?.message}`),
          );
      }

      this.logger.warn(
        `JET alert raised (${args.kind}) for order ${args.jetOrderId} at ${where}` +
          (detail ? `: ${detail}` : ""),
      );
    } catch (e: any) {
      // Deliberately terminal. Nothing above is worth failing an order for.
      this.logger.warn(`JET alert could not be raised: ${e?.message}`);
    }
  }

  private headline(kind: JetAlertKind): string {
    switch (kind) {
      case "ingest_failed":
        return "Just Eat order rejected";
      case "ack_failed":
        return "Just Eat order NOT acknowledged — it will be marked failed-to-inject";
      case "abandoned":
        return "Just Eat order abandoned past their window";
    }
  }

  /** True when this exact order+kind already alerted inside the quiet window. */
  private seenRecently(args: JetAlertArgs): boolean {
    const key = `${args.jetOrderId}:${args.kind}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last && now - last < QUIET_MS) return true;
    this.recent.set(key, now);
    // Cheap sweep so a long-running process does not hold every order id it
    // has ever failed on.
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) {
        if (now - t >= QUIET_MS) this.recent.delete(k);
      }
    }
    return false;
  }
}
