import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatApiError, TalabatClientService } from "./talabat-client.service";
import {
  TALABAT_AFTER_ACCEPT_REASONS,
  TALABAT_REJECT_REASONS,
  type TalabatRejectReason,
} from "./talabat-types";

// Phase TB-3 — our board, pushed back to Talabat.
//
// Every update goes to an absolute URL the ORDER carried in callbackUrls, and
// "in the cases when the URL is not present you should not be sending us that
// type of callback". So the URL's presence decides applicability per order:
//
//   orderAcceptedUrl                  accept (Direct integrations only)
//   orderRejectedUrl                  reject, with one of THEIR reasons
//   orderPreparedUrl                  food is ready (Talabat-rider orders only)
//   orderPickedUpUrl                  handed over (vendor delivery + pickup)
//   orderPreparationTimeAdjustmentUrl move the rider pickup time (AWT)
//   orderProductModificationUrl       remove/reduce lines after accepting
//
// ── The traps the spec names ────────────────────────────────────────────────
//
// • acceptanceTime must be at least 2 minutes after the request, or the accept
//   fails. For rider orders it "has no effect at all" but is still required.
// • A 409 on accept with currentState ASSIGNED_TO_TRANSPORT or
//   WAITING_FOR_ACKNOWLEDGEMENT "should be retried to avoid order being stuck
//   and getting cancelled automatically… every ~10 seconds for next 5 minutes".
// • Reject reasons are a fixed enum, and most are "before acceptance" only.
//   Cancelling an accepted order is only possible with the after-acceptance
//   reasons; anything else needs a phone call to Talabat, and staff are told.
// • Rejecting without a proper reason, or accepting with a badly formatted
//   datetime, are both listed in the Post Production Agreement as reasons
//   Delivery Hero disable an integration.
//
// Each callback is sent at most once per order (a WebhookEvent latch, as for
// Glovo), released if the call fails so a later transition can retry it.

const ACCEPT_RETRY_EVERY_MS = 10_000;
const ACCEPT_RETRY_FOR_MS = 5 * 60_000;
/** Their floor is 2 minutes; a little more so clock skew can't trip it. */
const MIN_ACCEPT_LEAD_MS = 3 * 60_000;
const DEFAULT_PREP_MINUTES = 20;
const DEFAULT_DELIVERY_MINUTES = 40;

/** Statuses that mean the kitchen has taken the order on. */
const ACCEPTING = new Set([
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PENDING_DISPATCH",
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
  "RIDER_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DISPATCHED",
  "COMPLETED",
]);

/**
 * Map what staff typed (or a cancel-reason code) onto Talabat's enum.
 *
 * Pure and exported: the judgement is worth reading and testing on its own.
 * Never returns something outside their list. Unrecognised text before
 * acceptance becomes TOO_BUSY — the honest default for a kitchen that said no
 * without saying why — and test orders always reject as TEST_ORDER.
 */
export function talabatRejectReason(raw: string | null | undefined, opts: { test?: boolean } = {}): TalabatRejectReason {
  if (opts.test) return "TEST_ORDER";
  const s = String(raw ?? "").trim();
  const upper = s.toUpperCase().replace(/[\s-]+/g, "_");
  const exact = TALABAT_REJECT_REASONS.find((r) => r === upper);
  if (exact) return exact;
  const t = s.toLowerCase();
  if (!t) return "TOO_BUSY";
  if (/out of stock|unavailable|sold out|\b86\b|no stock|ran out|run out/.test(t)) return "ITEM_UNAVAILABLE";
  if (/menu|price|wrong item|mapping|remote/.test(t)) return "MENU_ACCOUNT_SETTINGS";
  if (/clos(ed|ing)|shut|after hours|not open/.test(t)) return "CLOSED";
  if (/driver|courier|rider/.test(t)) return "NO_COURIER";
  if (/address/.test(t)) return "ADDRESS_INCOMPLETE_MISSTATED";
  if (/area|too far|out of range|zone/.test(t)) return "OUTSIDE_DELIVERY_AREA";
  if (/weather|storm|rain|sand/.test(t)) return "BAD_WEATHER";
  if (/fraud|prank|fake|spam/.test(t)) return "FRAUD_PRANK";
  if (/minimum|mov\b/.test(t)) return "MOV_NOT_REACHED";
  if (/system|outage|offline|technical|pos down|printer/.test(t)) return "TECHNICAL_PROBLEM";
  if (/late/.test(t)) return "LATE_DELIVERY";
  if (/quality|spill|cold/.test(t)) return "FOOD_QUALITY_SPILLAGE";
  if (/pay|card/.test(t)) return "UNABLE_TO_PAY";
  if (/can'?t find|cannot find|not found|no answer|unreachable/.test(t)) return "UNABLE_TO_FIND";
  if (/test/.test(t)) return "TEST_ORDER";
  return "TOO_BUSY";
}

/**
 * The acceptanceTime the spec wants, per order type, never under their floor.
 *
 *   rider order     → riderPickupTime ("plugins should use delivery.riderPickUpTime")
 *   vendor delivery → expectedDeliveryTime, else now + delivery estimate
 *   pickup          → pickupTime, else now + prep estimate
 */
export function talabatAcceptanceTime(
  t: {
    kind?: string;
    riderPickupTime?: string | null;
    expectedDeliveryTime?: string | null;
    pickupTime?: string | null;
  },
  opts: { now?: number; prepMinutes?: number; deliveryMinutes?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const prep = (opts.prepMinutes ?? DEFAULT_PREP_MINUTES) * 60_000;
  const deliver = (opts.deliveryMinutes ?? DEFAULT_DELIVERY_MINUTES) * 60_000;
  const parse = (s?: string | null) => {
    const v = s ? Date.parse(s) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  let at: number;
  if (t.kind === "OWN_DELIVERY") at = parse(t.riderPickupTime) ?? parse(t.expectedDeliveryTime) ?? now + prep;
  else if (t.kind === "VENDOR_DELIVERY") at = parse(t.expectedDeliveryTime) ?? now + prep + deliver;
  else at = parse(t.pickupTime) ?? now + prep;
  // "at least 2 minutes later than the sending time … otherwise acceptance
  // request will fail". A past rider time (a slow accept) is lifted, not sent.
  return new Date(Math.max(at, now + MIN_ACCEPT_LEAD_MS)).toISOString();
}

type Action = "accept" | "reject" | "prepared" | "picked_up";

interface SyncOrder {
  id: string;
  tenantId: string;
  locationId: string;
  brandId: string | null;
  displayId: string | null;
  externalId: string | null;
  status: string;
  failureReason: string | null;
  cancelReason: string | null;
  metadata: unknown;
}

@Injectable()
export class TalabatOrderSyncService {
  private readonly logger = new Logger(TalabatOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(payload: { orderId: string; tenantId: string; actorType?: string }): Promise<void> {
    // A transition Talabat caused (their cancel, the rider's pickup) is their
    // own news; echoing it back is noise at best.
    if (payload.actorType === "WEBHOOK") return;
    try {
      await this.sync(payload.orderId, payload.tenantId);
    } catch (err: any) {
      // Never rethrow into the transition — our order has already moved.
      this.logger.error(`Talabat sync threw for order ${payload.orderId}: ${err?.message}`);
    }
  }

  async sync(orderId: string, tenantId: string): Promise<{ sent: Action[]; skipped?: string }> {
    const order = await this.load(orderId, tenantId);
    if (!order) return { sent: [], skipped: "not_talabat" };
    const t = talabatMeta(order);
    if (!t.token) return { sent: [], skipped: "no_token" };
    if (t.simulated) return { sent: [], skipped: "simulated" };

    const status = String(order.status);
    const sent: Action[] = [];

    if (status === "CANCELLED" || status === "REJECTED" || status === "FAILED") {
      if (await this.reject(order)) sent.push("reject");
      return { sent };
    }
    if (!ACCEPTING.has(status)) return { sent };

    // Anything past PENDING implies an accept, even if staff jumped straight
    // to READY — Talabat must hear the accept first or the prepared call 409s.
    if (await this.accept(order)) sent.push("accept");

    if (status === "READY" && (await this.prepared(order))) sent.push("prepared");

    const handedOver =
      (t.kind === "PICKUP" && status === "COMPLETED") ||
      (t.kind === "VENDOR_DELIVERY" && ["OUT_FOR_DELIVERY", "DISPATCHED", "COMPLETED"].includes(status));
    if (handedOver && (await this.pickedUp(order))) sent.push("picked_up");

    return { sent };
  }

  // ── accept ─────────────────────────────────────────────────────────────

  private async accept(order: SyncOrder, attempt = 0, firstTriedAt = Date.now()): Promise<boolean> {
    const t = talabatMeta(order);
    const url = t.callbackUrls?.orderAcceptedUrl;
    // Absent on an Indirect integration: the order was accepted on Talabat's
    // tablet before it reached us, and there is nothing to say.
    if (!url) return false;
    if (attempt === 0 && !(await this.latch(order, "accept"))) return false;

    const prefs = await this.timePrefs(order);
    const body = {
      status: "order_accepted",
      acceptanceTime: talabatAcceptanceTime(t, prefs),
      remoteOrderId: order.id,
    };
    try {
      await this.client.callback(url, body);
      this.log(order, "accept", "SUCCESS", `accepted on Talabat (ready by ${body.acceptanceTime.slice(11, 16)} UTC)`);
      await this.noteSent(order.id, "accept");
      return true;
    } catch (err: any) {
      const retryable =
        err instanceof TalabatApiError &&
        err.status === 409 &&
        (err.currentState === "ASSIGNED_TO_TRANSPORT" ||
          err.currentState === "WAITING_FOR_ACKNOWLEDGEMENT" ||
          err.currentState === "RECEIVED" ||
          err.currentState == null);
      if (retryable && Date.now() - firstTriedAt < ACCEPT_RETRY_FOR_MS) {
        // Their instruction, literally: every ~10 s for the next 5 minutes.
        setTimeout(() => {
          void this.load(order.id, order.tenantId).then((fresh) => {
            if (fresh && ACCEPTING.has(String(fresh.status))) {
              void this.accept(fresh, attempt + 1, firstTriedAt);
            }
          });
        }, ACCEPT_RETRY_EVERY_MS).unref?.();
        if (attempt === 0) {
          this.log(order, "accept", "INFO", `Talabat is not ready to take the accept yet (${err.currentState ?? "409"}) — retrying for up to 5 minutes`);
        }
        return false;
      }
      await this.unlatch(order, "accept");
      this.log(
        order,
        "accept",
        "ERROR",
        `could not be accepted on Talabat: ${err?.message ?? err}. ` +
          "If it is not accepted before it expires, Talabat cancel it — accept it from the Talabat page or call Talabat.",
      );
      return false;
    }
  }

  // ── reject / cancel ────────────────────────────────────────────────────

  private async reject(order: SyncOrder): Promise<boolean> {
    const t = talabatMeta(order);
    const url = t.callbackUrls?.orderRejectedUrl;
    if (!url) return false;
    const accepted = !!t.sent?.accept;
    const why = order.cancelReason ?? order.failureReason;
    const reason = talabatRejectReason(why, { test: t.test });

    if (accepted && !TALABAT_AFTER_ACCEPT_REASONS.has(reason)) {
      // Sending it would be refused, and worse, logged against us as a reject
      // with an invalid reason. Tell staff the one thing that will work.
      this.log(
        order,
        "reject",
        "ERROR",
        `was cancelled here AFTER being accepted on Talabat. Talabat only allow that for delivery problems ` +
          `(late, food quality, customer unreachable…), not "${reason}". Call Talabat to cancel it, ` +
          `or their rider will still come.`,
      );
      return false;
    }
    if (!(await this.latch(order, "reject"))) return false;
    const body = {
      status: "order_rejected",
      reason,
      message: (why ?? "").slice(0, 250) || reason.replace(/_/g, " ").toLowerCase(),
    };
    try {
      await this.client.callback(url, body);
      this.log(order, "reject", "SUCCESS", `rejected on Talabat (${reason})`);
      await this.noteSent(order.id, "reject");
      return true;
    } catch (err: any) {
      await this.unlatch(order, "reject");
      this.log(order, "reject", "ERROR", `could not be rejected on Talabat: ${err?.message ?? err}. Call Talabat to cancel it.`);
      return false;
    }
  }

  // ── food ready / handed over ───────────────────────────────────────────

  private async prepared(order: SyncOrder): Promise<boolean> {
    const url = talabatMeta(order).callbackUrls?.orderPreparedUrl;
    // Only present for Talabat-rider orders. Absent = not applicable.
    if (!url) return false;
    if (!(await this.latch(order, "prepared"))) return false;
    try {
      await this.client.callback(url);
      this.log(order, "prepared", "SUCCESS", "marked food-ready on Talabat — the rider has been told");
      await this.noteSent(order.id, "prepared");
      return true;
    } catch (err: any) {
      await this.unlatch(order, "prepared");
      this.log(order, "prepared", "ERROR", `could not be marked ready on Talabat: ${err?.message ?? err}`);
      return false;
    }
  }

  private async pickedUp(order: SyncOrder): Promise<boolean> {
    const url = talabatMeta(order).callbackUrls?.orderPickedUpUrl;
    if (!url) return false;
    if (!(await this.latch(order, "picked_up"))) return false;
    try {
      await this.client.callback(url, { status: "order_picked_up" });
      this.log(order, "picked_up", "SUCCESS", "marked picked up on Talabat");
      await this.noteSent(order.id, "picked_up");
      return true;
    } catch (err: any) {
      await this.unlatch(order, "picked_up");
      this.log(order, "picked_up", "ERROR", `could not be marked picked up on Talabat: ${err?.message ?? err}`);
      return false;
    }
  }

  // ── AWT: dynamic preparation time ──────────────────────────────────────

  /**
   * Move the rider pickup time — Talabat's "AWT Dynamic Order Prep-Time
   * Adjustment", a mandatory API for certification.
   *
   * Validated here against the window the order arrived with, because their
   * own rule is that the range is fixed from the ORIGINAL time no matter how
   * often it is adjusted, and a request outside it fails. Allowed until the
   * rider has accepted the job (their table: vendor accepted + rider accepted
   * = no adjustments).
   */
  async adjustPrepTime(
    tenantId: string,
    orderId: string,
    input: { minutes?: number; expectedPickupAt?: string },
  ): Promise<{ expectedPickupAt: string }> {
    const order = await this.load(orderId, tenantId);
    if (!order) throw new NotFoundException("Talabat order not found");
    const t = talabatMeta(order);
    const url = t.callbackUrls?.orderPreparationTimeAdjustmentUrl;
    if (!url) {
      throw new BadRequestException(
        "Talabat did not offer a prep-time adjustment on this order — it only applies to Talabat-rider orders.",
      );
    }
    const base = Date.parse(t.prepAdjustedTo ?? t.riderPickupTime ?? "") || Date.now();
    const target =
      input.expectedPickupAt != null
        ? Date.parse(input.expectedPickupAt)
        : base + Math.round(Number(input.minutes ?? 0)) * 60_000;
    if (!Number.isFinite(target)) throw new BadRequestException("Give minutes or an expectedPickupAt time.");

    const min = Date.parse(t.prepTime?.minPickUpTimestamp ?? t.prepTime?.minPickupTimestamp ?? "");
    const max = Date.parse(t.prepTime?.maxPickUpTimestamp ?? "");
    if (Number.isFinite(min) && target < min) {
      throw new BadRequestException(`Talabat won't accept a pickup before ${new Date(min).toISOString()}.`);
    }
    if (Number.isFinite(max) && target > max) {
      throw new BadRequestException(`Talabat won't accept a pickup after ${new Date(max).toISOString()}.`);
    }
    const expectedPickupAt = new Date(target).toISOString();
    try {
      await this.client.callback(url, { expectedPickupAt });
    } catch (err: any) {
      const code = err instanceof TalabatApiError ? err.code : null;
      const why =
        code === "PREPARATION_TIME_EXCEEDS_ALLOWED_MAX_TIME"
          ? "that is later than Talabat allow"
          : code === "PREPARATION_TIME_BELOW_ALLOWED_MIN_TIME"
            ? "that is too soon for Talabat to assign a rider"
            : err instanceof TalabatApiError && err.status === 409
              ? "the rider has already accepted the job"
              : String(err?.message ?? err);
      this.log(order, "prep_time", "ERROR", `prep time could not be changed: ${why}`);
      throw new BadRequestException(`Talabat refused the new pickup time: ${why}.`);
    }
    await this.patchMeta(order, { prepAdjustedTo: expectedPickupAt });
    this.log(order, "prep_time", "SUCCESS", `rider pickup moved to ${expectedPickupAt.slice(11, 16)} UTC`);
    return { expectedPickupAt };
  }

  // ── Product modification (out-of-stock lines) ──────────────────────────

  /**
   * Remove lines, or reduce their quantity, after the order is accepted.
   *
   * Only what each line's itemUnavailabilityHandling allows: REMOVE for
   * removal, REDUCE_QUANTITY for a smaller quantity. One modification at a
   * time — the result arrives later as PRODUCT_ORDER_MODIFICATION_SUCCESSFUL
   * (with the updated order) or _FAILED, on our posOrderStatus endpoint.
   */
  async modifyProducts(
    tenantId: string,
    orderId: string,
    changes: Array<{ productId: string; remove?: boolean; quantity?: number }>,
  ): Promise<{ submitted: number }> {
    const order = await this.load(orderId, tenantId);
    if (!order) throw new NotFoundException("Talabat order not found");
    const t = talabatMeta(order);
    const url = t.callbackUrls?.orderProductModificationUrl;
    if (!url) throw new BadRequestException("Talabat did not offer product changes on this order.");
    if (!t.sent?.accept) {
      throw new BadRequestException("Accept the order first — Talabat only take product changes after acceptance.");
    }
    if (t.modification?.status === "PENDING") {
      throw new BadRequestException("A change is already waiting for Talabat's answer. Try again when it lands.");
    }
    const lines: Array<any> = Array.isArray(t.lines) ? t.lines : [];
    const products = changes.map((c) => {
      const line = lines.find((l) => l.id === c.productId);
      if (!line) throw new BadRequestException(`No line ${c.productId} on this order.`);
      if (!line.remoteCode) throw new BadRequestException(`"${line.name}" has no remoteCode — it can't be changed via the API.`);
      if (c.remove) {
        if (line.handling && line.handling !== "REMOVE") {
          throw new BadRequestException(`The customer chose "${line.handling}" for "${line.name}", not removal.`);
        }
        return { id: line.id, remoteCode: line.remoteCode, modification: { type: "REMOVAL" } };
      }
      const q = Math.round(Number(c.quantity));
      if (!(q >= 1) || q >= Number(line.quantity)) {
        throw new BadRequestException(`New quantity for "${line.name}" must be between 1 and ${Number(line.quantity) - 1}.`);
      }
      if (line.handling && line.handling !== "REDUCE_QUANTITY") {
        throw new BadRequestException(`The customer chose "${line.handling}" for "${line.name}", not a smaller quantity.`);
      }
      return {
        id: line.id,
        remoteCode: line.remoteCode,
        quantity: String(q),
        modification: { type: "CHANGE", properties: ["quantity"] },
      };
    });
    if (!products.length) throw new BadRequestException("Nothing to change.");
    await this.client.callback(url, { modifications: { products } });
    await this.patchMeta(order, { modification: { status: "PENDING", at: new Date().toISOString(), products } });
    this.log(order, "modify", "INFO", `asked Talabat to change ${products.length} line(s) — waiting for their answer`);
    return { submitted: products.length };
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private async load(orderId: string, tenantId: string): Promise<SyncOrder | null> {
    return this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "TALABAT" as any },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        displayId: true,
        externalId: true,
        status: true,
        failureReason: true,
        cancelReason: true,
        metadata: true,
      },
    }) as Promise<SyncOrder | null>;
  }

  private async timePrefs(order: SyncOrder) {
    const conn = await this.prisma.brandPlatformConnection
      .findFirst({
        where: { platform: "TALABAT", locationId: order.locationId, ...(order.brandId ? { brandId: order.brandId } : {}) },
        select: { metadata: true },
      })
      .catch(() => null);
    const m = (conn?.metadata ?? {}) as any;
    return {
      prepMinutes: Number(m.defaultPrepMinutes) > 0 ? Number(m.defaultPrepMinutes) : undefined,
      deliveryMinutes: Number(m.defaultDeliveryMinutes) > 0 ? Number(m.defaultDeliveryMinutes) : undefined,
    };
  }

  private async latch(order: SyncOrder, action: Action): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          platform: "TALABAT",
          externalEventId: `out:${order.externalId}:${action}`,
          tenantId: order.tenantId,
          locationId: order.locationId,
          orderId: order.id,
          rawPayload: {},
          metadata: { direction: "outbound" },
          processedAt: new Date(),
        },
      });
      return true;
    } catch (e: any) {
      if (e?.code === "P2002") return false;
      // Bookkeeping failed for another reason: sending twice beats never
      // telling Talabat the order was accepted.
      this.logger.warn(`Talabat latch write failed (${action} ${order.id}): ${e?.message}`);
      return true;
    }
  }

  private async unlatch(order: SyncOrder, action: Action): Promise<void> {
    await this.prisma.webhookEvent
      .delete({
        where: {
          platform_externalEventId: { platform: "TALABAT", externalEventId: `out:${order.externalId}:${action}` },
        },
      })
      .catch(() => undefined);
  }

  private async noteSent(orderId: string, action: Action) {
    const row = await this.prisma.order.findUnique({ where: { id: orderId }, select: { metadata: true } }).catch(() => null);
    const meta = (row?.metadata ?? {}) as any;
    const talabat = meta.talabat ?? {};
    await this.prisma.order
      .update({
        where: { id: orderId },
        data: {
          metadata: {
            ...meta,
            talabat: { ...talabat, sent: { ...(talabat.sent ?? {}), [action]: new Date().toISOString() } },
          } as any,
        },
      })
      .catch(() => undefined);
  }

  private async patchMeta(order: SyncOrder, patch: Record<string, unknown>) {
    const row = await this.prisma.order.findUnique({ where: { id: order.id }, select: { metadata: true } }).catch(() => null);
    const meta = (row?.metadata ?? order.metadata ?? {}) as any;
    await this.prisma.order
      .update({ where: { id: order.id }, data: { metadata: { ...meta, talabat: { ...(meta.talabat ?? {}), ...patch } } as any } })
      .catch(() => undefined);
  }

  private log(order: SyncOrder, action: string, status: "SUCCESS" | "INFO" | "ERROR", message: string) {
    if (status === "ERROR") this.logger.error(`Talabat ${action} ${order.id}: ${message}`);
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      brandId: order.brandId,
      category: "ORDERS",
      channel: "TALABAT",
      action: `order.${action}.push`,
      status,
      message: `Talabat order ${order.displayId ?? order.id} ${message}`,
      details: { token: order.externalId },
    });
  }
}

/** The talabat block the transformer wrote, typed loosely. */
export function talabatMeta(order: { metadata: unknown }): Record<string, any> {
  const m = (order.metadata ?? {}) as any;
  return { ...(m.talabat ?? {}), simulated: !!m.simulatedPlatform };
}
