// Phase BK — apply a Yango claim's state to an OrderHub order.
//
// This is the ONE place that turns "what Yango says" into order changes. Three
// callers feed it the same way:
//   • dispatch, right after creating the claim;
//   • the poller (yango-poll.cron.ts), which reads claims/bulk_info — the source
//     of truth, because Yango's callback is deprecated and gives up after a few
//     undocumented retries;
//   • the callback endpoint, which carries only claim_id and is unsigned, so it
//     is only ever a nudge to re-read claims/info from Yango ourselves.
//
// It also owns ACCEPTING. A claim is created in `new`, Yango estimates it, and
// it reaches `ready_for_approval` with a binding offer that must be accepted
// within ~10 minutes. Accepting is the call that sends a real courier and bills
// the shop, so it happens here only when:
//   - the location is in LIVE mode (estimate_only never accepts), and
//   - OrderHub itself created the claim meaning to book it (metadata flag), and
//   - the offer is not expired, and not more than YANGO_MAX_PRICE_DRIFT above
//     the check-price quote the operator dispatched against.
// Anything else abandons the claim — cancelled (free before acceptance), courier
// fields cleared, dispatch fee refunded — and says why in the activity log.

import { forwardRef, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { WalletService } from "../../wallet/wallet.service";
import { ActivityLogService, type ActivityStatus } from "../../logs/activity-log.service";
import { YangoApiError, YangoClaim, YangoClientService } from "./yango-client.service";
import type { DecryptedYangoConfig } from "./yango-config.service";
import {
  decimalOrNull,
  normStatus,
  offerVerdict,
  YANGO_CANCELLED_ELSEWHERE,
  YANGO_COURIER_LIVE,
  YANGO_FAILED_BY_YANGO,
  YANGO_RETURN_STATUSES,
  YANGO_STATUS_MAP,
  YANGO_TERMINAL,
} from "./yango-status";

export const YANGO_COURIER_FIELDS_CLEARED = {
  courierProvider: null,
  courierJobId: null,
  courierDeliveryId: null,
  courierName: null,
  courierPhone: null,
  courierPhoneAccessCode: null,
  courierTrackingUrl: null,
  courierStatus: null,
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
  courierEtaAt: null,
  courierPickupEtaAt: null,
  courierLat: null,
  courierLng: null,
  courierLocationAt: null,
  deliveryType: null,
};

export interface YangoOrderMeta {
  requestId?: string;
  quotedPrice?: number | null;
  currency?: string;
  /** True from create until accept (or abandon). Only claims WE created with
   *  this flag are ever accepted — never one found some other way. */
  acceptPending?: boolean;
  acceptedAt?: string;
  /** When dispatch created the claim — the poller leaves the accept to the
   *  dispatch call for its first seconds rather than racing it. */
  dispatchedAt?: string;
  offerPrice?: number | null;
  offerPriceWithVat?: number | null;
  finalPrice?: number | null;
  walletFeeMinor?: number;
  trackingFetched?: boolean;
  phoneFetched?: boolean;
  returnWarned?: boolean;
  lastStatus?: string;
  lastError?: string;
}

@Injectable()
export class YangoTrackingService {
  private readonly logger = new Logger(YangoTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: YangoClientService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  meta(order: any): YangoOrderMeta {
    const m = (order?.metadata ?? {}) as Record<string, any>;
    return ((m.yango ?? {}) as YangoOrderMeta) ?? {};
  }

  /** Merge into Order.metadata.yango without clobbering the rest of metadata. */
  async patchMeta(order: any, patch: Partial<YangoOrderMeta>, extra: Record<string, any> = {}) {
    const m = ((order.metadata ?? {}) as Record<string, any>) ?? {};
    const yango = { ...(m.yango ?? {}), ...patch };
    order.metadata = { ...m, yango };
    await this.db().order.update({
      where: { id: order.id },
      data: { metadata: order.metadata, ...extra },
    });
    Object.assign(order, extra);
  }

  private log(order: any, action: string, status: ActivityStatus, message: string, details: any = {}) {
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "YANGO",
      action,
      status,
      message,
      details: { claimId: order.courierJobId ?? details?.claimId ?? null, ...details },
    });
  }

  private async moveOrder(order: any, next: string, reason?: string) {
    if (!next || next === order.status) return;
    try {
      await this.orders.updateStatus(
        order.id,
        order.tenantId,
        { status: next as any, ...(reason ? { cancelReason: reason } : {}) } as any,
        "yango-tracking",
        "WEBHOOK" as any,
      );
      order.status = next;
    } catch (err: any) {
      this.logger.warn(`Order ${order.id} → ${next} rejected: ${err?.message ?? err}`);
    }
  }

  private async refundFee(order: any) {
    const fee = Number(this.meta(order).walletFeeMinor ?? 0);
    if (!(fee > 0)) return false;
    try {
      await this.wallet.refundDispatch({
        tenantId: order.tenantId,
        locationId: order.locationId,
        orderId: order.id,
        amountMinor: fee,
        createdBy: null,
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Yango dispatch-fee refund failed for order ${order.id}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Take the claim off the order: cancel it at Yango if it can still be
   * cancelled for free, clear the courier fields, optionally refund our fee,
   * and put a still-open order back to READY for someone to re-dispatch.
   *
   * Clearing courierProvider is also the idempotency guard — a later poll or
   * callback for this claim no longer resolves to the order, so nothing is
   * refunded twice.
   */
  async abandon(
    order: any,
    cfg: DecryptedYangoConfig | null,
    args: { reason: string; refund: boolean; cancelAtYango: boolean; action: string },
  ) {
    const claimId = order.courierJobId as string | null;
    let cancelledAtYango = false;
    if (args.cancelAtYango && cfg?.token && claimId) {
      try {
        const info = await this.client.cancelInfo(cfg, claimId);
        // Only FREE. Paying a cancellation fee is the operator's decision, made
        // through the cancel button, never something the poller does quietly.
        if (info?.cancel_state === "free") {
          const claim = await this.client.claimInfo(cfg, claimId);
          await this.client.cancelClaim(cfg, claimId, claim.version, "free");
          cancelledAtYango = true;
        }
      } catch (err: any) {
        this.logger.warn(`Yango cancel of abandoned claim ${claimId} failed: ${err?.message ?? err}`);
      }
    }
    await this.patchMeta(
      order,
      { acceptPending: false, lastError: args.reason },
      { ...YANGO_COURIER_FIELDS_CLEARED },
    );
    const refunded = args.refund ? await this.refundFee(order) : false;
    if (!["COMPLETED", "CANCELLED"].includes(String(order.status))) {
      await this.moveOrder(order, "READY");
    }
    this.log(
      { ...order, courierJobId: claimId },
      args.action,
      "WARNING",
      `Yango: ${args.reason}${refunded ? " The dispatch fee was refunded." : ""} Dispatch order ${order.displayId ?? order.id} again.`,
      { claimId, cancelledAtYango, refunded },
    );
    return { cancelledAtYango, refunded };
  }

  /** Accept a ready_for_approval claim, if and only if it is safe to. */
  async acceptIfDue(order: any, claim: YangoClaim, cfg: DecryptedYangoConfig) {
    const meta = this.meta(order);
    if (!meta.acceptPending) return { accepted: false, reason: "not_pending" };
    if (cfg.mode !== "live") {
      // The location was switched to estimate_only between create and accept.
      await this.abandon(order, cfg, {
        reason: "the location was switched to estimate-only before the courier was booked, so the claim was cancelled.",
        refund: true,
        cancelAtYango: true,
        action: "courier.abandoned",
      });
      return { accepted: false, reason: "estimate_only" };
    }
    const offer = claim.pricing?.offer ?? {};
    const offerPrice = decimalOrNull(offer.price ?? offer.price_with_vat);
    const verdict = offerVerdict({
      offerPrice,
      quotedPrice: meta.quotedPrice ?? null,
      validUntil: offer.valid_until,
    });
    if (!verdict.ok) {
      const cur = claim.pricing?.currency ?? meta.currency ?? "";
      const reason =
        verdict.reason === "expired"
          ? "the courier offer expired before it could be accepted, so no courier was booked."
          : verdict.reason === "too_expensive"
            ? `the courier price came back at ${offerPrice} ${cur}, well above the ${meta.quotedPrice} ${cur} quoted, so it was NOT accepted.`
            : "the claim came back with no price, so it was not accepted.";
      await this.abandon(order, cfg, {
        reason,
        refund: true,
        cancelAtYango: true,
        action: "courier.offer_refused",
      });
      return { accepted: false, reason: verdict.reason };
    }

    let version = claim.version;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.acceptClaim(cfg, claim.id, version);
        await this.patchMeta(
          order,
          {
            acceptPending: false,
            acceptedAt: new Date().toISOString(),
            offerPrice,
            offerPriceWithVat: decimalOrNull(offer.price_with_vat),
            lastStatus: normStatus(res?.status) || "accepted",
          },
          { courierStatus: (normStatus(res?.status) || "accepted").toUpperCase() },
        );
        this.log(order, "courier.accepted", "SUCCESS", `Yango courier booked for order ${order.displayId ?? order.id}.`, {
          offerPrice,
          currency: claim.pricing?.currency ?? meta.currency ?? null,
        });
        return { accepted: true };
      } catch (err: any) {
        const code = err instanceof YangoApiError ? err.code : null;
        if (code === "old_version" || code === "state_mismatch") {
          // Someone edited it; take the current version and try once more.
          const fresh = await this.client.claimInfo(cfg, claim.id);
          if (normStatus(fresh.status) !== "ready_for_approval") {
            return this.apply(order, fresh, cfg);
          }
          version = fresh.version;
          continue;
        }
        if (code === "inappropriate_status") {
          // Already accepted (a racing poll) or moved on — read and apply.
          const fresh = await this.client.claimInfo(cfg, claim.id);
          await this.patchMeta(order, { acceptPending: normStatus(fresh.status) === "ready_for_approval" });
          return this.apply(order, fresh, cfg);
        }
        // Never blindly retry an accept on a 5xx: it books a courier. The next
        // poll re-reads the claim and retries only if it is still waiting.
        await this.patchMeta(order, { lastError: String(err?.message ?? err).slice(0, 300) });
        this.logger.warn(`Yango accept failed for claim ${claim.id}: ${err?.message ?? err}`);
        return { accepted: false, reason: "error" };
      }
    }
    return { accepted: false, reason: "version_conflict" };
  }

  /** Apply one claim snapshot to its order. Idempotent: the poller calls it
   *  with the same snapshot many times. */
  async apply(order: any, claim: YangoClaim, cfg: DecryptedYangoConfig): Promise<any> {
    if (!claim?.id || order.courierProvider !== "YANGO" || order.courierJobId !== claim.id) {
      return { ok: false, reason: "not_this_order" };
    }
    const status = normStatus(claim.status);
    const meta = this.meta(order);

    if (status === "ready_for_approval") {
      return this.acceptIfDue(order, claim, cfg);
    }

    if (status === "estimating_failed" || YANGO_FAILED_BY_YANGO.has(status)) {
      const why = (claim.error_messages ?? [])
        .map((e) => e?.message || e?.code)
        .filter(Boolean)
        .join("; ");
      const label: Record<string, string> = {
        estimating_failed: "couldn't price this delivery",
        performer_not_found: "found no courier",
        cancelled_by_taxi: "the courier cancelled",
        failed: "the delivery failed",
      };
      await this.abandon(order, cfg, {
        reason: `${label[status] ?? status}${why ? ` (${why})` : ""}.`,
        refund: true,
        // Nothing left to cancel at Yango for these.
        cancelAtYango: false,
        action: "courier.failed",
      });
      return { ok: true, status };
    }

    if (YANGO_CANCELLED_ELSEWHERE.has(status)) {
      const itemsOnHands = status === "cancelled_with_items_on_hands";
      await this.patchMeta(order, { acceptPending: false, lastStatus: status }, { ...YANGO_COURIER_FIELDS_CLEARED });
      if (!itemsOnHands && !["COMPLETED", "CANCELLED"].includes(String(order.status))) {
        await this.moveOrder(order, "READY");
      }
      this.log(
        { ...order, courierJobId: claim.id },
        "courier.cancelled_elsewhere",
        "WARNING",
        itemsOnHands
          ? `Yango cancelled order ${order.displayId ?? order.id} and the courier KEPT the food — check with Yango and the customer.`
          : `The Yango delivery for order ${order.displayId ?? order.id} was cancelled outside OrderHub (${status}). It needs dispatching again.`,
        { claimId: claim.id, status },
      );
      return { ok: true, status };
    }

    const updates: Record<string, any> = {};
    const upper = status ? status.toUpperCase() : null;
    if (upper && upper !== order.courierStatus) updates.courierStatus = upper;

    const performer = claim.performer_info ?? {};
    const name = [performer.courier_name, performer.car_model, performer.car_number]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean)
      .join(" · ");
    if (name && name !== order.courierName) updates.courierName = name.slice(0, 190);

    const now = new Date();
    if (YANGO_COURIER_LIVE.has(status) && !order.courierAssignedAt) updates.courierAssignedAt = now;
    if (["pickuped", "delivery_arrived", "ready_for_delivery_confirmation", "delivered", "delivered_finish"].includes(status) && !order.courierPickedUpAt) {
      updates.courierPickedUpAt = now;
    }
    if ((status === "delivered" || status === "delivered_finish") && !order.courierDeliveredAt) {
      updates.courierDeliveredAt = now;
    }

    // ETAs come free with every claim read: expected visit times per point.
    for (const rp of claim.route_points ?? []) {
      const exp = rp?.visited_at?.expected;
      const d = exp ? new Date(exp) : null;
      if (!d || !Number.isFinite(d.getTime())) continue;
      if (rp.type === "source" && rp.visit_status !== "visited") updates.courierPickupEtaAt = d;
      if (rp.type === "destination" && rp.visit_status !== "visited") updates.courierEtaAt = d;
    }

    const metaPatch: Partial<YangoOrderMeta> = { lastStatus: status };
    const finalPrice = decimalOrNull(claim.pricing?.final_price);
    if (finalPrice != null) metaPatch.finalPrice = finalPrice;

    // Once a courier exists: the customer-safe tracking link, and the masked
    // courier phone for the SHOP (source point). One fetch each, not per poll.
    if (YANGO_COURIER_LIVE.has(status) && cfg.token) {
      if (!meta.trackingFetched) {
        try {
          const links = await this.client.trackingLinks(cfg, claim.id);
          const dest = (links?.route_points ?? []).find(
            (p: any) => p?.type === "destination" && typeof p?.sharing_link === "string",
          );
          if (dest && /^https?:\/\//i.test(dest.sharing_link)) updates.courierTrackingUrl = dest.sharing_link;
          metaPatch.trackingFetched = true;
        } catch {
          /* 409 before the link exists — try again next poll */
        }
      }
      if (!meta.phoneFetched) {
        const source = (claim.route_points ?? []).find((p) => p?.type === "source");
        if (source?.id != null) {
          try {
            const ph = await this.client.courierPhone(cfg, claim.id, source.id);
            if (typeof ph?.phone === "string" && ph.phone) {
              updates.courierPhone = ph.phone;
              updates.courierPhoneAccessCode = typeof ph?.ext === "string" && ph.ext ? ph.ext : null;
            }
            metaPatch.phoneFetched = true;
          } catch {
            /* not available yet */
          }
        }
      }
      try {
        const pos = await this.client.performerPosition(cfg, claim.id);
        const p = pos?.position ?? {};
        // Named lat/lon fields here (unlike the [lon, lat] we send). 0,0 is the
        // Atlantic, not a courier.
        const lat = Number(p.lat);
        const lng = Number(p.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
          updates.courierLat = lat;
          updates.courierLng = lng;
          const ts = Number(p.timestamp);
          updates.courierLocationAt = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : now;
        }
      } catch {
        /* unknown_performer_position — fine */
      }
    }

    if (YANGO_RETURN_STATUSES.has(status) && !meta.returnWarned) {
      metaPatch.returnWarned = true;
      this.log(
        order,
        "courier.return",
        "WARNING",
        `Yango is bringing order ${order.displayId ?? order.id} back to the shop (${status}) — decide whether to refund the customer.`,
        { status },
      );
    }

    await this.patchMeta(order, metaPatch, updates);

    const next = YANGO_STATUS_MAP[status] ?? null;
    if (next) await this.moveOrder(order, next);

    if (YANGO_TERMINAL.has(status)) {
      this.logger.log(`Yango claim ${claim.id} for order ${order.id} finished: ${status}`);
    }
    return { ok: true, status, moved: next };
  }
}
