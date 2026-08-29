// Phase BA-3b — Deliveroo inbound order routing.
//
// The webhook receiver (deliveroo-webhook.controller) has already
// HMAC-verified the request and recorded it idempotently. This service
// is where a *valid, first-seen* event turns into real work:
//
//   order.new           → resolve the connected store from the payload's
//                         site id → normalise → OrdersService.ingestCanonical
//   order.status_update → map Deliveroo's order status → our OrderStatus and
//                         drive OrdersService.updateStatus(actorType="WEBHOOK")
//   rider.status_update → write the courier-tracking columns + advance the
//                         order through the ASSIGNED_DRIVER → RIDER_ARRIVED →
//                         OUT_FOR_DELIVERY → COMPLETED chain.
//
// Mirrors HubRiseDeliverySyncService: inbound-only, best-effort, and the
// WEBHOOK actor type bypasses the operator PLATFORM-gate cleanly. Outbound
// accept/reject/cancel/sync_status/prep_stage lands in Phase 4.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { DeliverooAdapter } from "../../webhooks/adapters/deliveroo.adapter";
import {
  mapDeliverooOrderStatus,
  mapDeliverooRiderStatus,
  furthestRiderStage,
  furthestRiderRawStatus,
  riderCollectedFromLog,
  deliverooSiteIdFrom,
  deliverooOrderIdFrom,
} from "./deliveroo-order.mappers";

@Injectable()
export class DeliverooOrderService {
  private readonly logger = new Logger(DeliverooOrderService.name);

  // The webhook adapter is a pure, dependency-free normaliser. We reuse it
  // rather than duplicating Deliveroo's money/item/address parsing.
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly adapter: DeliverooAdapter,
  ) {}

  /** Top-level dispatch for a verified, first-seen webhook event. */
  async route(
    event: string,
    body: any,
  ): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const e = (event ?? "").toLowerCase();
    if (e.includes("rider")) return this.handleRiderUpdate(body);
    if (e === "order.new" || e === "new_order" || e.includes("new")) {
      return this.handleOrderNew(body);
    }
    if (e.includes("status") || e === "cancel_order") {
      return this.handleStatusUpdate(body, e);
    }
    // menu.* / anything else — nothing to do here (menu results land in Phase 5).
    return { handled: false, reason: `unrouted_event:${event}` };
  }

  // ── order.new → ingestCanonical ─────────────────────────

  /**
   * Shape probe — Deliveroo's customer/delivery layouts vary by
   * fulfillment_type and the docs don't enumerate them. Logging the raw
   * objects (truncated) lets us pin the real field names from production
   * traffic instead of guessing. Remove once the shapes are confirmed.
   */
  private logPayloadShape(kind: string, order: any): void {
    try {
      const j = (v: unknown) => JSON.stringify(v ?? null)?.slice(0, 500);
      this.logger.log(
        `Deliveroo ${kind} shape: fulfillment_type=${order?.fulfillment_type ?? "?"} ` +
          `customer=${j(order?.customer)} delivery=${j(order?.delivery)}`,
      );
    } catch {
      /* diagnostics only */
    }
  }

  async handleOrderNew(body: any): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const order = body?.body?.order ?? body?.order ?? body?.body ?? body;
    this.logPayloadShape("order.new", order);
    const externalId = deliverooOrderIdFrom(order, body?.body ?? body);
    if (!externalId) {
      this.logger.warn(
        `Deliveroo order.new without an order id (keys=${Object.keys(order ?? {}).join(",")})`,
      );
      return { handled: false, reason: "no_order_id" };
    }

    const siteId = deliverooSiteIdFrom(order, body?.body ?? body);
    if (!siteId) {
      this.logger.warn(
        `Deliveroo order.new ${externalId}: could not find a site id (order keys=${Object.keys(order ?? {}).join(",")})`,
      );
      return { handled: false, reason: "no_site_id" };
    }

    // Resolve the connected brand/location for this Deliveroo site.
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "DELIVEROO",
        externalStoreId: siteId,
        status: { not: "not_connected" },
      },
      select: { tenantId: true, brandId: true, locationId: true },
    });
    if (!conn) {
      this.logger.warn(
        `Deliveroo order.new ${externalId}: no connected brand for site ${siteId} — ignoring`,
      );
      return { handled: false, reason: "site_not_connected" };
    }

    // Reuse the proven adapter normaliser (money/items/address/customer).
    const canonical = this.adapter.normalize({ order }, conn.locationId);
    if (!canonical) {
      this.logger.warn(`Deliveroo order.new ${externalId}: adapter returned null`);
      return { handled: false, reason: "normalize_null" };
    }

    // Direct integration: we know the brand from the connection (no name
    // hint needed). deliveryType comes from the adapter's fulfillment_type
    // mapping (deliveroo rider → PLATFORM so the operator UI gates post-READY
    // steps and rider webhooks drive them; restaurant fleet → MERCHANT;
    // pickup/dine-in → none). Fallback keeps older payloads gated.
    (canonical as any).brandId = conn.brandId ?? undefined;
    (canonical as any).deliveryType =
      (canonical.metadata as any)?.deliveryType ??
      (canonical.fulfillmentType === "PICKUP" ||
      canonical.fulfillmentType === "DINE_IN"
        ? undefined
        : "PLATFORM");

    const created = await this.orders.ingestCanonical(
      canonical,
      conn.tenantId,
      conn.locationId,
    );
    this.logger.log(
      `Deliveroo order.new ${externalId} → order ${created.id} (site ${siteId})`,
    );
    return { handled: true, orderId: created.id };
  }

  // ── order.status_update → updateStatus ──────────────────

  async handleStatusUpdate(
    body: any,
    eventName = "",
  ): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const order = body?.body?.order ?? body?.order ?? body?.body ?? body;
    this.logPayloadShape("status_update", order);
    const externalId = deliverooOrderIdFrom(order, body?.body ?? body);
    if (!externalId) return { handled: false, reason: "no_order_id" };

    const rawStatus = order?.status ?? body?.body?.status ?? body?.status;
    // Legacy `cancel_order` carries the cancellation intent in the event name
    // itself — it may not ship an explicit status field.
    const mapped =
      mapDeliverooOrderStatus(rawStatus) ??
      (eventName === "cancel_order" ? "CANCELLED" : null);

    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "DELIVEROO" },
      select: {
        id: true,
        tenantId: true,
        status: true,
        deliveryAddress: true,
        customerPhone: true,
        customerInfo: true,
      },
    });
    if (!row) {
      // status_update can race ahead of order.new — 200 + ignore; the
      // eventual order.new (or a retry) lands the order.
      this.logger.warn(
        `Deliveroo status_update for unknown order ${externalId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    // Backfill customer address/contact from this event. Deliveroo can omit
    // these on order.new (privacy hold until acceptance) or the order may
    // predate an adapter fix — later status_updates carry the full order, so
    // fill whatever the row is still missing. Runs even for unmapped/no-op
    // statuses.
    await this.backfillCustomerFields(row, order, externalId);

    if (!mapped) return { handled: false, reason: `unmapped_status:${rawStatus}` };
    if (row.status === mapped) return { handled: false, reason: "no_change" };

    try {
      await this.orders.updateStatus(
        row.id,
        row.tenantId,
        {
          status: mapped as any,
          cancelReason:
            mapped === "CANCELLED"
              ? "Cancelled on Deliveroo"
              : mapped === "REJECTED"
                ? "Rejected on Deliveroo"
                : undefined,
        } as any,
        "deliveroo-webhook",
        "WEBHOOK",
      );
      this.logger.log(
        `Deliveroo status_update ${externalId}: ${row.status} → ${mapped}`,
      );
      return { handled: true, orderId: row.id };
    } catch (err: any) {
      // Illegal transition (out-of-order echo) — log + swallow, same as HubRise.
      this.logger.warn(
        `Deliveroo status_update ${externalId} → ${mapped} rejected: ${err?.message}`,
      );
      return { handled: false, reason: "transition_rejected", orderId: row.id };
    }
  }

  /**
   * Fill customer address / phone / access code the row is still missing,
   * using this event's order payload (parsed by the same adapter as
   * order.new). Best-effort — never fails the webhook.
   */
  private async backfillCustomerFields(
    row: {
      id: string;
      deliveryAddress: unknown;
      customerPhone: string | null;
      customerInfo: unknown;
    },
    order: any,
    externalId: string,
  ): Promise<void> {
    try {
      const canonical = this.adapter.normalize({ order }, "");
      if (!canonical) return;
      const updates: Record<string, any> = {};
      if (canonical.deliveryAddress && !row.deliveryAddress) {
        updates.deliveryAddress = canonical.deliveryAddress;
      }
      const phone = canonical.customerInfo?.phone;
      if (phone && !row.customerPhone) {
        updates.customerPhone = phone;
      }
      const accessCode = (canonical.customerInfo as any)?.phoneAccessCode;
      const existingInfo = (row.customerInfo ?? {}) as Record<string, any>;
      if (
        (phone && !existingInfo.phone) ||
        (accessCode && !existingInfo.phoneAccessCode)
      ) {
        updates.customerInfo = {
          ...existingInfo,
          ...(phone && !existingInfo.phone ? { phone } : {}),
          ...(accessCode && !existingInfo.phoneAccessCode
            ? { phoneAccessCode: accessCode }
            : {}),
        };
      }
      if (Object.keys(updates).length) {
        await this.prisma.order.update({
          where: { id: row.id },
          data: updates as any,
        });
        this.logger.log(
          `Deliveroo ${externalId}: backfilled ${Object.keys(updates).join(",")} from status_update`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `Deliveroo ${externalId}: customer backfill failed: ${e?.message}`,
      );
    }
  }

  // ── rider.status_update → courier columns + status ──────

  async handleRiderUpdate(body: any): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const inner = body?.body ?? body;
    const order = inner?.order ?? inner;
    const externalId = deliverooOrderIdFrom(order, inner);
    if (!externalId) return { handled: false, reason: "no_order_id" };

    // Deliveroo's REAL rider.status_update payload nests rider data under
    // `body.riders[]` — a plural ARRAY whose entries carry `full_name`,
    // `contact_number`, `bridge_number`/`bridge_code`, and a `status_log[]`
    // history ({at, status}, latest stage last). The singular `rider` object
    // (with a top-level `status`) our first cut looked for never exists, so
    // every event parsed to nothing. We read the array first and fall back to
    // the old/doc shapes for safety.
    const ridersArr = Array.isArray(inner?.riders)
      ? inner.riders
      : Array.isArray(order?.riders)
        ? order.riders
        : null;
    const rider =
      (ridersArr && ridersArr[ridersArr.length - 1]) ??
      inner?.rider ??
      order?.rider ??
      {};

    const statusLog: Array<{ at?: string; status?: string }> = Array.isArray(
      rider?.status_log,
    )
      ? rider.status_log
      : [];
    const latestLog = statusLog.length ? statusLog[statusLog.length - 1] : null;

    // Values are the rider.status_update vocabulary (rider_assigned …
    // rider_check_in … rider_delivered) handled in mapDeliverooRiderStatus.
    const rawStatus =
      latestLog?.status ??
      inner?.status ??
      inner?.rider_status ??
      order?.status ??
      order?.rider_status ??
      rider?.status ??
      rider?.rider_status;

    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "DELIVEROO" },
    });
    const o = row as any;
    if (!o) {
      this.logger.warn(
        `Deliveroo rider update for unknown order ${externalId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    // Advance to the FURTHEST-progressed stage anywhere in the log, not just
    // the last entry — Deliveroo can append a non-terminal line (e.g.
    // rider_unassigned) AFTER rider_delivered, which would otherwise leave a
    // delivered order stuck at "out for delivery". See furthestRiderStage.
    // `courierStatus` still shows the latest raw value for the UI.
    const allStatuses = [rawStatus, ...statusLog.map((e) => e?.status)];

    // Deliveroo never sends rider_in_transit or rider_delivered to the
    // merchant — tracking is cut at pickup and the log ends with
    // rider_unassigned. That unassign, once the rider has been at the
    // restaurant, IS the collection signal. See riderCollectedFromLog.
    const collected = riderCollectedFromLog(statusLog.map((e) => e?.status));
    const stage = furthestRiderStage(allStatuses);
    const mapped =
      collected && (stage === null || stage === "ASSIGNED_DRIVER" || stage === "RIDER_ARRIVED")
        ? "OUT_FOR_DELIVERY"
        : stage;

    // Write courier-tracking columns. Timestamps are set once (first event
    // wins) so a re-delivered event can't clobber the original pickup time.
    const updates: Record<string, any> = {};
    const joined = [rider?.first_name, rider?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const riderName =
      rider?.full_name ??
      rider?.name ??
      rider?.rider_name ??
      (joined || undefined) ??
      inner?.rider_name;
    const riderPhone =
      rider?.contact_number ??
      rider?.bridge_number ??
      rider?.phone ??
      rider?.phone_number;
    // The bridge number is a shared switchboard line: dialling it without the
    // code reaches nobody. We were reading the number and dropping the code,
    // which is the half that makes the call connect.
    const riderPhoneCode =
      rider?.bridge_code ??
      rider?.contact_access_code ??
      rider?.access_code ??
      rider?.phone_access_code;
    if (riderName) updates.courierName = riderName;
    if (riderPhone) updates.courierPhone = riderPhone;
    if (riderPhoneCode) updates.courierPhoneAccessCode = String(riderPhoneCode);


    // WHY the board can read "Deliveroo Rider" where a name should be.
    //
    // Nothing in this codebase invents a courier name — line above is the only
    // writer, and it copies the payload verbatim. So a generic name on the
    // board means Deliveroo sent a generic name: they withhold rider identity
    // from merchants and put a placeholder in `full_name`.
    //
    // This logs the KEYS on the rider object so a future payload that does
    // carry a real name (a `first_name`, a `display_name` we don't read) is
    // visible without going back to webhook_events. The name VALUE is logged
    // only when it looks like a placeholder — that is the case worth
    // diagnosing, and a real rider's name doesn't belong in the log stream.
    const looksGeneric =
      typeof riderName === "string" &&
      /^(a |the )?(deliveroo |roo )?(rider|courier|driver)$/i.test(
        riderName.trim(),
      );
    this.logger.log(
      `Deliveroo rider identity ${externalId}: ` +
        `name=${riderName ? (looksGeneric ? `PLACEHOLDER "${riderName}"` : "<present>") : "MISSING"} ` +
        `phone=${riderPhone ? "<present>" : "MISSING"} ` +
        `code=${riderPhoneCode ? "<present>" : "MISSING"} ` +
        `riderKeys=[${Object.keys(rider ?? {}).join(",")}]` +
        (looksGeneric
          ? " — Deliveroo is withholding the rider's name; ask your account " +
            "manager to enable rider details, this is not a bug our side."
          : ""),
    );
    // Deliveroo sends TWO different estimates and they answer different
    // questions. `estimated_arrival_time` is the rider reaching the SHOP;
    // `estimated_delivery_time` is them reaching the CUSTOMER.
    //
    // arrival_time now ALSO feeds the board's ETA column via
    // courierPickupEtaAt. What it does NOT do is change what courierEtaAt has
    // always been, because that column decides when a platform-courier order
    // auto-completes — Deliveroo never reports the delivery itself — and
    // narrowing it on an inference from two field names could close every
    // Deliveroo order a whole delivery early, or stop closing them at all.
    //
    // So: new behaviour added, old behaviour untouched, and the two values
    // logged side by side when both arrive. A handful of real orders will show
    // whether arrival really is the shop and delivery really is the customer,
    // and then this can be split properly on evidence.
    //
    // Always overwritten. An estimate that cannot move is not an estimate.
    const asDate = (v: unknown) => {
      if (!v) return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    // Live rider position, for the dispatch map.
    //
    // Deliveroo puts lat/lon/accuracy_in_meters/at on every rider event and we
    // were dropping all four. `at` is the moment the fix was taken, not the
    // moment we received it — a pin is only honest if the map can tell how old
    // it is, so the timestamp is stored with the point and never invented.
    // 0,0 is Deliveroo's "we have stopped sharing" value, not a place in the
    // Atlantic, so it is rejected rather than plotted.
    const lat = Number(rider?.lat);
    const lng = Number(rider?.lon ?? rider?.lng);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      !(lat === 0 && lng === 0)
    ) {
      updates.courierLat = lat;
      updates.courierLng = lng;
      updates.courierLocationAt = asDate(rider?.at) ?? new Date();
    }

    const arrival = asDate(rider?.estimated_arrival_time);
    const delivery = asDate(rider?.estimated_delivery_time);

    if (arrival) updates.courierPickupEtaAt = arrival;
    // Unchanged from before this column existed.
    const legacyEta = arrival ?? delivery;
    if (legacyEta) updates.courierEtaAt = legacyEta;

    // One line per rider event carrying an estimate, whichever arrived.
    //
    // The gap between the two is the evidence that decides whether
    // estimated_arrival_time means the SHOP or the CUSTOMER — and therefore
    // whether courierEtaAt, which auto-completes these orders, is counting to
    // the wrong moment. HubRise relaying the same couriers sends
    // estimated_pickup_at and estimated_dropoff_at twenty minutes apart, so
    // the equivalent gap here would settle it.
    //
    // Logged even when only ONE estimate arrives, because "Deliveroo only ever
    // sends arrival" is itself the answer to a different question, and the
    // previous version stayed silent in exactly that case.
    if (arrival || delivery) {
      const gap =
        arrival && delivery
          ? `${Math.round((delivery.getTime() - arrival.getTime()) / 60_000)}m apart`
          : "only one sent";
      this.logger.log(
        `Deliveroo rider estimates [${gap}] arrival=${arrival?.toISOString() ?? "-"} ` +
          `delivery=${delivery?.toISOString() ?? "-"} stage=${rawStatus ?? "-"} ` +
          `— a consistent positive gap means arrival is the SHOP and courierEtaAt ` +
          `should switch to delivery.`,
      );
    }

    // The last MEANINGFUL stage, not the last line. Deliveroo appends
    // rider_unassigned once it stops sharing the rider, so writing the bare
    // latest value showed a rider who was standing in the shop as "not
    // assigned" on the board.
    const displayStatus = furthestRiderRawStatus(allStatuses) ?? rawStatus;
    if (displayStatus) updates.courierStatus = String(displayStatus);

    // The payload carries the full stage history every time, so timestamp each
    // milestone from the log's own `at` (exact + idempotent), falling back to
    // now() when only a bare status arrived. First value wins — a later event
    // can't clobber the original pickup/delivery time.
    const stageAt = (...names: string[]): Date | null => {
      const hit = statusLog.find((e) => names.includes(String(e?.status)));
      return hit?.at ? new Date(hit.at) : null;
    };
    if (!o.courierAssignedAt) {
      const at =
        stageAt("rider_assigned") ??
        (mapped === "ASSIGNED_DRIVER" ? new Date() : null);
      if (at) updates.courierAssignedAt = at;
    }
    if (!o.courierPickedUpAt) {
      const at =
        stageAt("rider_in_transit", "collected", "picked_up") ??
        (mapped === "OUT_FOR_DELIVERY" ? new Date() : null);
      if (at) updates.courierPickedUpAt = at;
    }
    if (!o.courierDeliveredAt) {
      const at =
        stageAt("rider_delivered") ??
        (mapped === "COMPLETED" ? new Date() : null);
      if (at) updates.courierDeliveredAt = at;
    }
    if (Object.keys(updates).length) {
      await this.prisma.order.update({
        where: { id: o.id },
        data: updates as any,
      });
    }

    // Advance the order lifecycle if the rider moved into a new stage.
    let statusChanged = false;
    if (mapped && mapped !== o.status) {
      // Deliveroo fans the SAME rider state out as several events with
      // different sequence guids, milliseconds apart — three landed on one
      // order inside a second. Each handler writes the courier columns, which
      // bumps updatedAt, which invalidates the optimistic-concurrency snapshot
      // the sibling handler is holding, and its transition is thrown away with
      // "Order was modified by another request".
      //
      // Here that cost nothing, because a duplicate carried the same stage.
      // The event that gets discarded is chosen by timing, though, so the one
      // lost could just as easily be the only delivery of a real forward
      // stage — and nothing would retry it.
      //
      // Retry on the conflict alone. updateStatus re-reads the order each
      // attempt, so a retry cannot force a transition the fresh state
      // disallows, and we stop early if a sibling already applied ours.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.orders.updateStatus(
            o.id,
            o.tenantId,
            { status: mapped as any } as any,
            "deliveroo-rider-webhook",
            "WEBHOOK",
          );
          statusChanged = true;
          break;
        } catch (err: any) {
          const conflict =
            err?.status === 409 ||
            /modified by another request/i.test(String(err?.message ?? ""));
          if (!conflict || attempt === 3) {
            this.logger.warn(
              `Deliveroo rider ${externalId} → ${mapped} rejected` +
                (conflict ? ` after ${attempt} attempts` : "") +
                `: ${err?.message}`,
            );
            break;
          }
          const fresh = await this.prisma.order.findUnique({
            where: { id: o.id },
            select: { status: true },
          });
          if (fresh?.status === mapped) {
            // A sibling event won the race with the same stage. Nothing lost.
            break;
          }
          await new Promise((r) => setTimeout(r, 40 * attempt));
        }
      }
    }

    // The WHOLE history, not just the latest line.
    //
    // furthestRiderStage reads every entry, so "why is this order still Out
    // for delivery?" is really "did rider_delivered ever arrive?" — and the
    // latest status alone can't answer it. Deliveroo appends
    // rider_unassigned after a delivery, so the last line is routinely NOT
    // the furthest stage.
    const history = statusLog.map((e) => e?.status).filter(Boolean).join(" → ");
    this.logger.log(
      `Deliveroo rider ${externalId}: status=${rawStatus ?? "?"} ` +
        `shown=${displayStatus ?? "?"} collected=${collected} ` +
        `order_status=${mapped ?? "(unchanged)"} fields=${Object.keys(updates).length}` +
        (history ? ` | log: ${history}` : " | log: (none)"),
    );
    return {
      handled: Object.keys(updates).length > 0 || statusChanged,
      orderId: o.id,
    };
  }
}
